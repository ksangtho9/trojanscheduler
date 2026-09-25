"""
test_upstream_failures.py — tests for surviving a flaky USC Schedule of Classes.

Run: python3 test_upstream_failures.py
Exits non-zero on any failure.

No network: every test drives the retry helper and the API through fake clients
that fail on demand, so the retry, degradation and error-surfacing behavior are
deterministic. USC's API times out or 5xxs on individual department endpoints,
and these pin the contract that one blip must not fail a whole request — and
that when a request genuinely can't be served, the client is told why instead of
being handed a bare 500.
"""
from __future__ import annotations
import asyncio
import sys
import traceback

import main
import rmp
import scraper
import terms
from scraper import UpstreamError, _get_json, clear_dept_cache

# Silence disk writes during tests (same guard as test_rmp.py).
rmp._save_rmp_cache = lambda: None


FALL = "20263"

ACTIVE = [
    {"termCode": 20263, "status": "Active"},
    {"termCode": 20262, "status": "Active"},
    {"termCode": 20261, "status": "Active"},
]


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def make_raw_section(section_id: str) -> dict:
    return {
        "sisSectionId": section_id,
        "rnrMode": "Lecture",
        "linkCode": "L1",
        "isCancelled": False,
        "instructors": [{"firstName": "Ada", "lastName": "Lovelace"}],
        "units": ["4"],
        "totalSeats": 30,
        "registeredSeats": 5,
        "schedule": [{"days": ["Mon"], "startTime": "10:00", "endTime": "11:50"}],
    }


def make_course(code: str, section_id: str) -> dict:
    dept, number = code.split()
    return {
        "prefix": dept,
        "classNumber": number,
        "fullCourseName": code,
        "sections": [make_raw_section(section_id)],
    }


class FakeResponse:
    """Matches the rest of the suite: raise_for_status() and json() only."""

    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self):
        return self._payload


class FlakyClient:
    """Fails the first `fail_times` calls, then succeeds. Counts every call."""

    def __init__(self, payload, fail_times: int = 0):
        self.payload = payload
        self.fail_times = fail_times
        self.calls = 0

    async def get(self, url, params=None):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("network down")
        return FakeResponse(self.payload)


class CourseClient:
    """
    Stands in for the app's shared httpx client, failing the department fetch
    for the course codes named in `fail_courses`.
    """

    def __init__(self, fail_courses: set[str] | None = None):
        self.fail_courses = fail_courses or set()
        self.dept_calls: list[dict] = []

    async def get(self, url, params=None):
        params = params or {}
        if url.endswith("/Terms/All"):
            return FakeResponse(ACTIVE)
        if url.endswith("/Programs/TermCode"):
            return FakeResponse([
                {"prefix": "CSCI", "schools": [{"prefix": "ENGV"}]},
                {"prefix": "MATH", "schools": [{"prefix": "DORS"}]},
            ])
        if url.endswith("/Courses/CoursesByTermSchoolProgram"):
            self.dept_calls.append(params)
            dept = params.get("program")
            if dept in self.fail_courses:
                raise RuntimeError(f"{dept} endpoint unavailable")
            if dept == "CSCI":
                return FakeResponse({"courses": [make_course("CSCI 270", "CSCI270-1")]})
            return FakeResponse({"courses": [make_course("MATH 225", "MATH225-1")]})
        return FakeResponse({})


class LookupFailClient(CourseClient):
    """Fails the department→school lookup, which every request needs."""

    async def get(self, url, params=None):
        if url.endswith("/Programs/TermCode"):
            raise RuntimeError("Programs/TermCode unavailable")
        return await super().get(url, params)


def run(coro):
    return asyncio.run(coro)


def no_retry_delay():
    """Collapse the backoff so retry tests don't sleep for real."""
    scraper.RETRY_BACKOFF = 0.0


def fresh_app(client):
    """Reset all cross-test state and install a fake client on the app."""
    main.http_client = client
    main._school_lookups.clear()
    main._school_lookup_locks.clear()
    terms.clear_terms_cache()
    clear_dept_cache()
    return client


def api():
    from fastapi.testclient import TestClient
    # Bypass lifespan: it would start the background GE warmer loop.
    return TestClient(main.app)


def generate_body(courses, nice=(), term_code=None) -> dict:
    body = {
        "must_haves": [{"type": "course", "code": c} for c in courses],
        "nice_to_haves": [{"type": "course", "code": c} for c in nice],
        "constraints": {
            "earliest_start": "08:00",
            "latest_end": "20:00",
            "days_off": [],
            "max_units": 20,
            "no_back_to_back": False,
            "modality": "no_preference",
        },
        "planning_mode": True,
    }
    if term_code is not None:
        body["term_code"] = term_code
    return body


# ---------------------------------------------------------------------------
# Tests — the retry helper
# ---------------------------------------------------------------------------

def test_transient_failure_is_retried_then_succeeds():
    no_retry_delay()
    client = FlakyClient({"ok": True}, fail_times=2)
    result = run(_get_json(client, "https://usc.test/api", {}))
    assert result == {"ok": True}, f"retry did not recover: {result}"
    assert client.calls == 3, f"expected 3 attempts, got {client.calls}"


def test_persistent_failure_raises_upstream_error():
    no_retry_delay()
    client = FlakyClient({"ok": True}, fail_times=99)
    try:
        run(_get_json(client, "https://usc.test/api", {}))
    except UpstreamError:
        return
    raise AssertionError("a persistent failure did not raise UpstreamError")


def test_underlying_cause_is_not_leaked_as_a_bare_error():
    """Callers key on UpstreamError; a raw RuntimeError would slip past them."""
    no_retry_delay()
    client = FlakyClient({"ok": True}, fail_times=99)
    try:
        run(_get_json(client, "https://usc.test/api", {}))
    except UpstreamError as e:
        assert isinstance(e.__cause__, RuntimeError), f"cause not chained: {e.__cause__!r}"
        return
    raise AssertionError("expected UpstreamError")


def test_retries_stop_once_past_the_deadline():
    """
    The deadline gates whether a NEW attempt starts. With it at zero, the first
    failure is terminal — no second attempt — which is what keeps a slow read
    timeout from being re-issued.
    """
    no_retry_delay()
    original = scraper.RETRY_DEADLINE_S
    scraper.RETRY_DEADLINE_S = 0.0
    try:
        client = FlakyClient({"ok": True}, fail_times=99)
        try:
            run(_get_json(client, "https://usc.test/api", {}))
        except UpstreamError:
            pass
        assert client.calls == 1, f"retried past the deadline: {client.calls} calls"
    finally:
        scraper.RETRY_DEADLINE_S = original


def test_fake_response_without_status_code_still_works():
    """
    Pins the contract that the helper never requires `status_code`: every
    FakeResponse in this suite implements only raise_for_status() and json().
    """
    no_retry_delay()
    client = FlakyClient({"courses": []})
    result = run(_get_json(client, "https://usc.test/api", {}))
    assert result == {"courses": []}, f"unexpected payload: {result}"


# ---------------------------------------------------------------------------
# Tests — the API surface
# ---------------------------------------------------------------------------

def test_failing_must_have_returns_503_naming_the_course():
    no_retry_delay()
    fresh_app(CourseClient(fail_courses={"CSCI"}))
    r = api().post("/generate", json=generate_body(["CSCI 270"], term_code=FALL))
    assert r.status_code == 503, f"expected 503, got {r.status_code}: {r.text}"
    detail = r.json()["detail"]
    assert "CSCI 270" in detail, f"detail does not name the course: {detail}"


def test_failing_nice_to_have_does_not_fail_the_request():
    no_retry_delay()
    fresh_app(CourseClient(fail_courses={"MATH"}))
    r = api().post("/generate", json=generate_body(["CSCI 270"], nice=["MATH 225"], term_code=FALL))
    assert r.status_code == 200, f"a nice-to-have outage broke the request: {r.text}"
    body = r.json()
    assert body.get("schedules"), f"no schedules returned: {body.get('error')}"


def test_failing_school_lookup_is_503_not_500():
    """A 500 escapes above CORSMiddleware, so the browser never sees the body."""
    no_retry_delay()
    fresh_app(LookupFailClient())
    r = api().post("/generate", json=generate_body(["CSCI 270"], term_code=FALL))
    assert r.status_code == 503, f"expected 503, got {r.status_code}: {r.text}"
    assert "detail" in r.json(), f"no detail to show the user: {r.text}"


def test_course_options_degrades_to_the_empty_shape():
    """
    An error body here would be cached by the client and crash the picker, so
    the endpoint must answer with the shape the frontend expects.
    """
    no_retry_delay()
    fresh_app(CourseClient(fail_courses={"CSCI"}))
    r = api().get("/course-options", params={"code": "CSCI 270", "term": FALL})
    assert r.status_code == 200, f"expected a graceful 200, got {r.status_code}: {r.text}"
    body = r.json()
    assert body == {"professors": [], "sections": []}, f"unexpected shape: {body}"


def test_healthy_request_still_works():
    """Guard against the error handling swallowing the success path."""
    no_retry_delay()
    fresh_app(CourseClient())
    r = api().post("/generate", json=generate_body(["CSCI 270"], term_code=FALL))
    assert r.status_code == 200, f"healthy request failed: {r.text}"
    body = r.json()
    assert body.get("schedules"), f"no schedules returned: {body.get('error')}"
    assert body.get("term_code") == FALL, f"term not echoed: {body.get('term_code')}"


TESTS = [
    test_transient_failure_is_retried_then_succeeds,
    test_persistent_failure_raises_upstream_error,
    test_underlying_cause_is_not_leaked_as_a_bare_error,
    test_retries_stop_once_past_the_deadline,
    test_fake_response_without_status_code_still_works,
    test_failing_must_have_returns_503_naming_the_course,
    test_failing_nice_to_have_does_not_fail_the_request,
    test_failing_school_lookup_is_503_not_500,
    test_course_options_degrades_to_the_empty_shape,
    test_healthy_request_still_works,
]


def main_() -> int:
    passed = 0
    failed: list[tuple[str, str]] = []
    for fn in TESTS:
        name = fn.__name__
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e) or "assertion failed"))
            print(f"FAIL  {name}: {e}")
            continue
        except Exception:
            failed.append((name, traceback.format_exc()))
            print(f"ERROR {name}:")
            traceback.print_exc()
            continue
        passed += 1
        print(f"PASS  {name}")
    print()
    print(f"{passed}/{len(TESTS)} passed, {len(failed)} failed")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main_())

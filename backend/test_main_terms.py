"""
test_main_terms.py — API-level tests for term selection and validation.

Run: python3 test_main_terms.py
Exits non-zero on any failure.

Drives the real FastAPI app with the HTTP client and term cache stubbed, so
the routing, validation and term-echo behavior are exercised without network.
"""
from __future__ import annotations
import asyncio
import sys
import traceback

import main
import terms
from scraper import clear_dept_cache

FALL = "20263"
SPRING = "20261"

ACTIVE = [
    {"termCode": 20263, "status": "Active"},
    {"termCode": 20262, "status": "Active"},
    {"termCode": 20261, "status": "Active"},
    {"termCode": 20253, "status": "Archived"},
]


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self):
        return self._payload


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


class FakeClient:
    """Stands in for the app's shared httpx client."""

    def __init__(self):
        self.dept_calls: list[dict] = []

    async def get(self, url, params=None):
        params = params or {}
        if url.endswith("/Terms/All"):
            return FakeResponse(ACTIVE)
        if url.endswith("/Programs/TermCode"):
            return FakeResponse([{"prefix": "CSCI", "schools": [{"prefix": "ENGV"}]}])
        if url.endswith("/Courses/CoursesByTermSchoolProgram"):
            self.dept_calls.append(params)
            term = str(params.get("termCode"))
            marker = "FALL" if term == FALL else "SPRING"
            return FakeResponse({"courses": [{
                "prefix": "CSCI",
                "classNumber": "270",
                "fullCourseName": "CSCI 270",
                "sections": [make_raw_section(f"{marker}-CSCI270")],
            }]})
        return FakeResponse({})


def fresh_client() -> FakeClient:
    """Reset all cross-test state and install a fresh fake client."""
    client = FakeClient()
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


def generate_body(term_code=None, **extra) -> dict:
    body = {
        "must_haves": [{"type": "course", "code": "CSCI 270"}],
        "nice_to_haves": [],
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
    body.update(extra)
    return body


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_terms_endpoint_lists_active_terms_and_default():
    fresh_client()
    r = api().get("/terms")
    assert r.status_code == 200, r.text
    body = r.json()
    codes = [t["term_code"] for t in body["terms"]]
    assert codes == [FALL, "20262", SPRING], f"unexpected terms: {codes}"
    assert body["default"] == FALL
    assert body["terms"][0]["label"] == "Fall 2026"


def test_generate_without_term_uses_the_default():
    client = fresh_client()
    r = api().post("/generate", json=generate_body())
    assert r.status_code == 200, r.text
    assert r.json()["term_code"] == FALL
    assert all(c["termCode"] == FALL for c in client.dept_calls), "scraped the wrong term"


def test_generate_honors_an_explicit_active_term():
    client = fresh_client()
    r = api().post("/generate", json=generate_body(SPRING))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["term_code"] == SPRING
    assert body["term_label"] == "Spring 2026"
    assert all(c["termCode"] == SPRING for c in client.dept_calls), "scraped the wrong term"


def test_generate_rejects_an_archived_term_without_scraping():
    client = fresh_client()
    r = api().post("/generate", json=generate_body("20253"))
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    detail = r.json()["detail"]
    assert "20253" in detail, "error should name the rejected term"
    assert FALL in detail, "error should list the valid terms"
    assert not client.dept_calls, "an invalid term must fail before any scraping happens"


def test_generate_rejects_malformed_terms():
    for bad in ["fall", "", "999", "20264"]:
        client = fresh_client()
        r = api().post("/generate", json=generate_body(bad))
        if bad == "":
            # Empty string means "unspecified" and falls back to the default.
            assert r.status_code == 200, f"empty term should default: {r.text}"
            continue
        assert r.status_code == 400, f"{bad!r} should be rejected, got {r.status_code}"
        assert not client.dept_calls, f"{bad!r} scraped before validating"


def test_course_options_honors_its_term_parameter():
    client = fresh_client()
    r = api().get("/course-options", params={"code": "CSCI 270", "term": SPRING})
    assert r.status_code == 200, r.text
    assert all(c["termCode"] == SPRING for c in client.dept_calls), "wrong term scraped"


def test_course_options_rejects_an_invalid_term():
    fresh_client()
    r = api().get("/course-options", params={"code": "CSCI 270", "term": "20253"})
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"


def test_two_terms_in_sequence_each_get_their_own_sections():
    # The API-boundary regression guard for the shared dept cache.
    fresh_client()
    c = api()
    fall = c.post("/generate", json=generate_body(FALL)).json()
    spring = c.post("/generate", json=generate_body(SPRING)).json()
    assert fall["term_code"] == FALL and spring["term_code"] == SPRING

    def section_ids(body):
        return [
            course["section_id"]
            for sched in body.get("schedules") or []
            for course in sched["courses"]
        ]

    fall_ids, spring_ids = section_ids(fall), section_ids(spring)
    assert fall_ids, f"Fall returned no schedules: {fall.get('error')}"
    assert spring_ids, f"Spring returned no schedules: {spring.get('error')}"
    assert all("FALL" in i for i in fall_ids), f"Fall got foreign sections: {fall_ids}"
    assert all("SPRING" in i for i in spring_ids), (
        f"Spring was served Fall's cached sections: {spring_ids}"
    )


def test_health_reports_loaded_terms():
    fresh_client()
    c = api()
    c.post("/generate", json=generate_body(SPRING))
    body = c.get("/health").json()
    assert body["status"] == "ok"
    assert SPRING in body["terms_loaded"], f"term not tracked: {body}"


TESTS = [
    test_terms_endpoint_lists_active_terms_and_default,
    test_generate_without_term_uses_the_default,
    test_generate_honors_an_explicit_active_term,
    test_generate_rejects_an_archived_term_without_scraping,
    test_generate_rejects_malformed_terms,
    test_course_options_honors_its_term_parameter,
    test_course_options_rejects_an_invalid_term,
    test_two_terms_in_sequence_each_get_their_own_sections,
    test_health_reports_loaded_terms,
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

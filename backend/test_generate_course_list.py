"""
test_generate_course_list.py — exit-status contract for the course generator.

Run: python3 test_generate_course_list.py
Exits non-zero on any failure.

These exist because the generator's return value is what the scheduled
refresh workflow keys on. A successful run that reports itself as skipped
makes the CI step exit non-zero, so the rollover PR never gets opened -- and
nothing about the generated data looks wrong when that happens.
"""
from __future__ import annotations
import asyncio
import json
import os
import sys
import tempfile
import traceback

import generate_course_list as G


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self):
        return self._payload


class FakeClient:
    """One department with `count` courses, for whichever term is asked."""

    def __init__(self, count: int = 3):
        self.count = count

    async def get(self, url, params=None, timeout=None):
        if url.endswith("/Programs/TermCode"):
            return FakeResponse([{"prefix": "CSCI", "schools": [{"prefix": "ENGV"}]}])
        return FakeResponse({"courses": [
            {"prefix": "CSCI", "classNumber": f"{100 + i}", "name": f"Course {i}",
             "courseUnits": ["4"]}
            for i in range(self.count)
        ]})


class FakeMultiClient:
    """One department returning several prefixes, e.g. {"CSCI": 40, "MATH": 960}."""

    def __init__(self, counts: dict[str, int]):
        self.counts = counts

    async def get(self, url, params=None, timeout=None):
        if url.endswith("/Programs/TermCode"):
            return FakeResponse([{"prefix": "ALL", "schools": [{"prefix": "ENGV"}]}])
        return FakeResponse({"courses": [
            {"prefix": prefix, "classNumber": f"{100 + i}", "name": f"{prefix} {i}", "courseUnits": ["4"]}
            for prefix, n in self.counts.items()
            for i in range(n)
        ]})


def with_temp_public(fn):
    """Redirect generated output into a temp dir for the duration of a test."""
    def wrapper():
        original = G.PUBLIC_DIR
        with tempfile.TemporaryDirectory() as tmp:
            G.PUBLIC_DIR = tmp
            try:
                return fn(tmp)
            finally:
                G.PUBLIC_DIR = original
    wrapper.__name__ = fn.__name__
    return wrapper


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@with_temp_public
def test_successful_run_reports_success(tmp):
    # The regression guard: a run that writes a file must report True, or the
    # CI step exits non-zero and the refresh PR is never opened.
    result = run(G.generate_for_term("20262", FakeClient(3), force=False))
    assert result is True, f"a successful generation must return True, got {result!r}"
    assert os.path.exists(G.out_path("20262")), "file should have been written"


@with_temp_public
def test_successful_run_writes_the_expected_courses(tmp):
    run(G.generate_for_term("20262", FakeClient(3), force=False))
    data = json.load(open(G.out_path("20262")))
    assert len(data) == 3, f"expected 3 courses, got {len(data)}"
    assert data[0]["code"].startswith("CSCI "), data[0]


@with_temp_public
def test_writes_to_the_term_specific_filename(tmp):
    run(G.generate_for_term("20261", FakeClient(2), force=False))
    assert os.path.exists(os.path.join(tmp, "courses.20261.json"))
    assert not os.path.exists(os.path.join(tmp, "courses.json")), "must not write an unsuffixed file"


@with_temp_public
def test_shrink_guard_refuses_and_reports_failure(tmp):
    run(G.generate_for_term("20262", FakeClient(5), force=False))       # seed 5
    result = run(G.generate_for_term("20262", FakeClient(2), force=False))  # now only 2
    assert result is False, "a refused overwrite must return False"
    data = json.load(open(G.out_path("20262")))
    assert len(data) == 5, "the existing larger file must survive a refused overwrite"


@with_temp_public
def test_force_overrides_the_shrink_guard(tmp):
    run(G.generate_for_term("20262", FakeClient(5), force=False))
    result = run(G.generate_for_term("20262", FakeClient(2), force=True))
    assert result is True, "a forced overwrite must report success"
    assert len(json.load(open(G.out_path("20262")))) == 2, "force should have overwritten"


@with_temp_public
def test_equal_totals_are_not_treated_as_a_shrink(tmp):
    # A no-op weekly refresh is the common case; it must not look like failure.
    run(G.generate_for_term("20262", FakeClient(4), force=False))
    result = run(G.generate_for_term("20262", FakeClient(4), force=False))
    assert result is True, "an unchanged total must still report success"


@with_temp_public
def test_small_real_shrink_is_accepted(tmp):
    # Mid-term cancellations: a couple of courses vanish. That is real change,
    # not a failed fetch, and must not fail the weekly refresh.
    run(G.generate_for_term("20263", FakeMultiClient({"CSCI": 100, "MATH": 100}), force=False))
    result = run(G.generate_for_term("20263", FakeMultiClient({"CSCI": 99, "MATH": 98}), force=False))
    assert result is True, "a <3% shrink with no department collapse must be accepted"
    assert len(json.load(open(G.out_path("20263")))) == 197, "the smaller, real list should be written"


@with_temp_public
def test_one_truncated_department_is_refused(tmp):
    # The USC failure mode: one department comes back short while the total
    # barely moves (CSCI 40 -> 28 is -30%, the term overall only -1.2%).
    run(G.generate_for_term("20263", FakeMultiClient({"CSCI": 40, "MATH": 960}), force=False))
    result = run(G.generate_for_term("20263", FakeMultiClient({"CSCI": 28, "MATH": 960}), force=False))
    assert result is False, "a department losing 25%+ must be refused even if the total looks fine"
    assert len(json.load(open(G.out_path("20263")))) == 1000, "the existing file must survive"


TESTS = [
    test_successful_run_reports_success,
    test_successful_run_writes_the_expected_courses,
    test_writes_to_the_term_specific_filename,
    test_shrink_guard_refuses_and_reports_failure,
    test_force_overrides_the_shrink_guard,
    test_equal_totals_are_not_treated_as_a_shrink,
    test_small_real_shrink_is_accepted,
    test_one_truncated_department_is_refused,
]


def main() -> int:
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
    sys.exit(main())

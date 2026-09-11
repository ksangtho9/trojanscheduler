"""
test_ge_finder.py — tests for term-scoped GE candidate discovery.

Run: python3 test_ge_finder.py
Exits non-zero on any failure.

No network: a fake client serves a different GE catalog per term so cross-term
leakage in the GE path is detectable the same way it is in the scraper.
"""
from __future__ import annotations
import asyncio
import sys
import traceback

import ge_finder
from ge_finder import (
    CATEGORY_PREFIX_MAP,
    build_ge_candidates,
    fetch_ge_course_codes,
    warm_ge_departments,
)
from scraper import clear_dept_cache

FALL = "20263"
SPRING = "20261"


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
    """
    GE course lists and department catalogs both vary by term, so a term mixup
    anywhere in the chain shows up as the wrong section id.
    """

    def __init__(self, fail_terms: set[str] | None = None):
        self.ge_calls: list[dict] = []
        self.dept_calls: list[dict] = []
        self.fail_terms = fail_terms or set()

    async def get(self, url, params=None):
        params = params or {}
        term = str(params.get("termCode"))
        if term in self.fail_terms:
            raise RuntimeError(f"term {term} unavailable")
        if url.endswith("/Courses/GeCoursesByTerm"):
            self.ge_calls.append(params)
            return FakeResponse({"courses": [{"fullCourseName": "AHIS 120"}]})
        if url.endswith("/Courses/CoursesByTermSchoolProgram"):
            self.dept_calls.append(params)
            marker = "FALL" if term == FALL else "SPRING"
            return FakeResponse({"courses": [{
                "prefix": "AHIS",
                "classNumber": "120",
                "fullCourseName": "AHIS 120",
                "sections": [make_raw_section(f"{marker}-AHIS120")],
            }]})
        return FakeResponse({})


LOOKUP = {"AHIS": "DORS"}


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_ge_course_codes_request_the_given_term():
    client = FakeClient()
    run(fetch_ge_course_codes("A", client, SPRING))
    assert client.ge_calls[0]["termCode"] == SPRING, f"wrong term: {client.ge_calls[0]}"


def test_ge_candidates_are_isolated_per_term():
    clear_dept_cache()
    client = FakeClient()
    fall = run(build_ge_candidates(["A"], LOOKUP, client, FALL))
    spring = run(build_ge_candidates(["A"], LOOKUP, client, SPRING))

    fall_ids = [s["section_id"] for s in fall["Category A"]]
    spring_ids = [s["section_id"] for s in spring["Category A"]]
    assert fall_ids == ["FALL-AHIS120"], f"unexpected Fall pool: {fall_ids}"
    assert spring_ids == ["SPRING-AHIS120"], (
        f"Spring GE pool was served Fall's cached catalog: {spring_ids}"
    )


def test_ge_candidate_sections_carry_their_category():
    clear_dept_cache()
    client = FakeClient()
    result = run(build_ge_candidates(["A"], LOOKUP, client, FALL))
    section = result["Category A"][0]
    assert section["course_code"] == "AHIS 120"
    assert "A" in section["ge_categories"], f"category missing: {section['ge_categories']}"


def test_warmer_covers_the_term_it_was_given():
    clear_dept_cache()
    client = FakeClient()
    run(warm_ge_departments(LOOKUP, client, SPRING))
    assert client.ge_calls, "warmer should have fetched GE course lists"
    assert all(c["termCode"] == SPRING for c in client.ge_calls), "warmer crossed terms"


def test_warmer_survives_a_failing_term():
    # A term that errors must not take down warming for the others.
    clear_dept_cache()
    client = FakeClient(fail_terms={SPRING})
    warmed_spring = run(warm_ge_departments(LOOKUP, client, SPRING))
    warmed_fall = run(warm_ge_departments(LOOKUP, client, FALL))
    assert warmed_spring == 0, "a fully failing term should warm nothing"
    assert warmed_fall > 0, "a healthy term must still warm after another term failed"


def test_empty_category_list_short_circuits():
    clear_dept_cache()
    client = FakeClient()
    assert run(build_ge_candidates([], LOOKUP, client, FALL)) == {}
    assert not client.ge_calls, "no categories should mean no fetches"


def test_unknown_category_is_ignored():
    clear_dept_cache()
    client = FakeClient()
    assert run(build_ge_candidates(["ZZZ"], LOOKUP, client, FALL)) == {}


def test_category_map_is_not_term_dependent():
    # Verified against USC: /api/Ge/TermCode is identical across active terms
    # once the echoed termCode is stripped, which is why this map is static.
    assert "A" in CATEGORY_PREFIX_MAP and "GESM" in CATEGORY_PREFIX_MAP
    assert not hasattr(ge_finder, "TERM_CODE"), "ge_finder must not hold a term constant"


TESTS = [
    test_ge_course_codes_request_the_given_term,
    test_ge_candidates_are_isolated_per_term,
    test_ge_candidate_sections_carry_their_category,
    test_warmer_covers_the_term_it_was_given,
    test_warmer_survives_a_failing_term,
    test_empty_category_list_short_circuits,
    test_unknown_category_is_ignored,
    test_category_map_is_not_term_dependent,
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

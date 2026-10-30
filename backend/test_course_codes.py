"""
test_course_codes.py — lettered course codes (CHEM 105A vs 105B) and GE-only
prefixes (GESM), both reported by a user on 2026-10-30.

Run: python3 test_course_codes.py
Exits non-zero on any failure. No network: USC responses are faked.
"""
from __future__ import annotations

import asyncio
import sys
import traceback

import ge_finder
import scraper
from scraper import (
    AmbiguousCourseCode,
    canonical_code,
    find_course,
    lettered_variants,
    normalize_code,
)


def raw(prefix: str, number: str, sequence: str | None = None, full: str | None = None) -> dict:
    """A raw USC course object, shaped like CoursesByTermSchoolProgram output."""
    return {
        "prefix": prefix,
        "classNumber": number,
        "sequence": sequence,
        "fullCourseName": full if full is not None else f"{prefix} {number}{sequence or ''}",
        "sections": [],
    }


CHEM = [raw("CHEM", "105", "A"), raw("CHEM", "105", "B"), raw("CHEM", "115", "B"), raw("CHEM", "300")]


# ── normalize_code / canonical_code ──────────────────────────────────────────

def test_normalize_accepts_the_ways_students_type_codes():
    for typed in ["chem105a", "CHEM-105A", " chem  105a ", "Chem 105A"]:
        assert normalize_code(typed) == "CHEM 105A", (typed, normalize_code(typed))
    assert normalize_code("gesm-110") == "GESM 110"
    assert normalize_code("csci 270") == "CSCI 270"


def test_canonical_code_keeps_the_letter():
    assert canonical_code(raw("CHEM", "105", "A")) == "CHEM 105A"
    # Falls back to prefix + number + sequence when fullCourseName is missing
    assert canonical_code(raw("CHEM", "105", "B", full="")) == "CHEM 105B"
    assert canonical_code(raw("CSCI", "270", None, full="")) == "CSCI 270"


# ── find_course ──────────────────────────────────────────────────────────────

def test_lettered_codes_resolve_to_their_own_course():
    assert find_course(CHEM, "CHEM 105A") is CHEM[0]
    assert find_course(CHEM, "chem105b") is CHEM[1], "105B must not resolve to 105A"


def test_bare_code_with_several_variants_does_not_guess():
    assert find_course(CHEM, "CHEM 105") is None, "must not silently pick 105A"
    assert lettered_variants(CHEM, "CHEM 105") == ["CHEM 105A", "CHEM 105B"]


def test_bare_code_with_one_variant_resolves():
    assert find_course(CHEM, "CHEM 115") is CHEM[2], "only 115B exists, so CHEM 115 means it"
    assert lettered_variants(CHEM, "CHEM 115") == []


def test_unlettered_courses_still_work():
    assert find_course(CHEM, "CHEM 300") is CHEM[3]
    assert find_course(CHEM, "CHEM 999") is None


def test_scrape_course_raises_for_ambiguous_codes():
    async def fake_dept(dept, school, client, term_code, block_on_miss=True):
        return CHEM

    original = scraper._get_dept_courses
    scraper._get_dept_courses = fake_dept
    try:
        try:
            asyncio.run(scraper.scrape_course("CHEM 105", None, {"CHEM": "DRNS"}, "20271"))
        except AmbiguousCourseCode as e:
            assert e.variants == ["CHEM 105A", "CHEM 105B"], e.variants
        else:
            raise AssertionError("expected AmbiguousCourseCode for bare CHEM 105")
        # A lettered request goes through normally (empty sections in this fake)
        assert asyncio.run(scraper.scrape_course("CHEM 105B", None, {"CHEM": "DRNS"}, "20271")) == []
    finally:
        scraper._get_dept_courses = original


# ── GESM: GE-only prefix with no department ──────────────────────────────────

def test_gesm_sections_come_from_the_ge_listing():
    term = "29991"
    gesm_110 = raw("GESM", "110")
    ge_finder._ge_course_objects[term] = {"GESM 110": gesm_110}
    ge_finder._ge_codes_cache[f"{term}:GESM"] = (10**12, ["GESM 110"])  # fresh, never expires in-test

    seen = []

    def fake_extract(course):
        seen.append(course)
        return [{"section_id": "70001", "course": "GESM 110"}]

    original_extract = ge_finder.extract_sections
    ge_finder.extract_sections = fake_extract
    try:
        pools = asyncio.run(ge_finder.build_ge_candidates(
            ["GESM"], school_lookup={}, client=None, term_code=term, block_on_miss=False,
        ))
    finally:
        ge_finder.extract_sections = original_extract
        ge_finder._ge_course_objects.pop(term, None)
        ge_finder._ge_codes_cache.pop(f"{term}:GESM", None)

    assert seen == [gesm_110], "GESM 110's own GE-listing object must be used for its sections"
    total = sum(len(v) for v in pools.values())
    assert total >= 1, f"expected a GESM candidate, got {pools}"


# ── Section topics (GESM 110 "Women in Hip Hop") ─────────────────────────────

def test_section_topic_is_kept():
    sec = {"sisSectionId": "35276", "rnrMode": "Lecture", "name": "Women in Hip Hop",
           "schedule": [{"days": ["Tue", "Thu"], "startTime": "11:00", "endTime": "12:20"}],
           "instructors": [], "units": ["4"], "totalSeats": 2, "registeredSeats": 1}
    parsed = scraper._parse_section(sec)
    assert parsed["topic"] == "Women in Hip Hop", parsed
    assert scraper._parse_section({**sec, "name": ""})["topic"] is None, "blank names must not become topics"


def test_ge_only_sections_come_from_the_listing():
    term = "29992"
    ge_finder._ge_course_objects[term] = {"GESM 110": raw("GESM", "110")}

    def fake_extract(course):
        return [{"section_id": "35276", "topic": "Women in Hip Hop"}]

    original = ge_finder.extract_sections
    ge_finder.extract_sections = fake_extract
    try:
        got = asyncio.run(ge_finder.ge_only_course_sections("GESM 110", None, term))
        assert got and got[0]["topic"] == "Women in Hip Hop", got
        # Not a GE-only prefix → None, so the caller uses the department path
        assert asyncio.run(ge_finder.ge_only_course_sections("CHEM 105A", None, term)) is None
    finally:
        ge_finder.extract_sections = original
        ge_finder._ge_course_objects.pop(term, None)


TESTS = [
    test_normalize_accepts_the_ways_students_type_codes,
    test_canonical_code_keeps_the_letter,
    test_lettered_codes_resolve_to_their_own_course,
    test_bare_code_with_several_variants_does_not_guess,
    test_bare_code_with_one_variant_resolves,
    test_unlettered_courses_still_work,
    test_scrape_course_raises_for_ambiguous_codes,
    test_gesm_sections_come_from_the_ge_listing,
    test_section_topic_is_kept,
    test_ge_only_sections_come_from_the_listing,
]


def main() -> int:
    failed = 0
    for fn in TESTS:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
        except Exception:
            failed += 1
            print(f"ERROR {fn.__name__}:")
            traceback.print_exc()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

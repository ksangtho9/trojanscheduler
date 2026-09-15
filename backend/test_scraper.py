"""
test_scraper.py — tests for term-scoped scraping and caching.

Run: python3 test_scraper.py          # offline, deterministic
     python3 test_scraper.py --live   # hits classes.usc.edu (smoke check)

Exits non-zero on any failure.

The central contract here is that the department cache is keyed by term. Once
the term is chosen per-request, a cache keyed only by school+dept would hand a
Fall catalog to a Spring request -- silently, with data that looks entirely
plausible. Several tests below exist purely to fail if the term ever falls out
of a cache key.
"""
from __future__ import annotations
import asyncio
import sys
import traceback

import scraper
from scraper import (
    _is_primary_mode,
    build_school_lookup,
    clear_dept_cache,
    extract_sections,
    fetch_dept_courses,
    lookup_section_in_cache,
    scrape_course,
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def make_raw_section(
    section_id: str,
    mode: str = "Lecture",
    link_code: str = "L1",
    cancelled: bool = False,
) -> dict:
    return {
        "sisSectionId": section_id,
        "rnrMode": mode,
        "linkCode": link_code,
        "isCancelled": cancelled,
        "instructors": [{"firstName": "Ada", "lastName": "Lovelace"}],
        "units": ["4"],
        "totalSeats": 30,
        "registeredSeats": 10,
        "schedule": [{"days": ["Mon"], "startTime": "10:00", "endTime": "11:50"}],
    }


def make_course(prefix: str, number: str, sections: list[dict]) -> dict:
    return {"prefix": prefix, "classNumber": number, "sections": sections}


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self):
        return self._payload


class FakeClient:
    """
    Serves a different catalog per term so cross-term leakage is detectable:
    a section id present in one term is absent from the other.
    """

    def __init__(self, by_term: dict[str, list[dict]] | None = None):
        self.by_term = by_term or {}
        self.calls: list[dict] = []

    async def get(self, url, params=None):
        params = params or {}
        self.calls.append(params)
        if url.endswith("/Programs/TermCode"):
            return FakeResponse([{"prefix": "CSCI", "schools": [{"prefix": "ENGV"}]}])
        term = str(params.get("termCode"))
        return FakeResponse({"courses": self.by_term.get(term, [])})


FALL = "20263"
SPRING = "20261"


def two_term_client() -> FakeClient:
    return FakeClient({
        FALL:   [make_course("CSCI", "270", [make_raw_section("FALL-1")])],
        SPRING: [make_course("CSCI", "270", [make_raw_section("SPRING-1")])],
    })


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Characterization: parsing behavior that must not change
# ---------------------------------------------------------------------------

def test_combined_lecture_modes_count_as_primary():
    # USC ships "Lecture/Discussion" as a self-contained primary with no
    # linkCode. Treating it as a secondary would attach it to every real
    # lecture in the course.
    assert _is_primary_mode("Lecture")
    assert _is_primary_mode("Seminar")
    assert _is_primary_mode("Lecture/Discussion")
    assert _is_primary_mode("Lecture/Lab")
    assert not _is_primary_mode("Discussion")
    assert not _is_primary_mode("Lab")


def test_cancelled_sections_are_excluded():
    course = make_course("CSCI", "270", [
        make_raw_section("LIVE"),
        make_raw_section("DEAD", cancelled=True),
    ])
    ids = [s["section_id"] for s in extract_sections(course)]
    assert ids == ["LIVE"], f"cancelled section leaked through: {ids}"


def test_orphan_secondary_attaches_to_every_primary():
    course = make_course("EE", "141", [
        make_raw_section("LEC-A", "Lecture", "L1"),
        make_raw_section("LEC-B", "Lecture", "L2"),
        make_raw_section("DIS-ORPHAN", "Discussion", "L9"),
    ])
    result = extract_sections(course)
    assert len(result) == 2, "both lectures should survive as primaries"
    for sec in result:
        linked = [ls["section_id"] for ls in sec["linked_sections"]]
        assert "DIS-ORPHAN" in linked, f"orphan discussion not attached: {linked}"


# ---------------------------------------------------------------------------
# Term threading and cache isolation
# ---------------------------------------------------------------------------

def test_school_lookup_requests_the_term_it_was_given():
    client = FakeClient()
    run(build_school_lookup(client, SPRING))
    assert client.calls[0]["termCode"] == SPRING, f"wrong term sent: {client.calls[0]}"


def test_fetching_two_terms_issues_two_requests():
    clear_dept_cache()
    client = two_term_client()
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    run(fetch_dept_courses("CSCI", "ENGV", client, SPRING))
    dept_calls = [c for c in client.calls if "program" in c]
    assert len(dept_calls) == 2, f"expected one fetch per term, got {len(dept_calls)}"


def test_cached_term_data_is_not_served_for_another_term():
    # The core regression guard: fails if the term falls out of the cache key.
    clear_dept_cache()
    client = two_term_client()
    fall = run(scrape_course("CSCI 270", client, {"CSCI": "ENGV"}, FALL))
    spring = run(scrape_course("CSCI 270", client, {"CSCI": "ENGV"}, SPRING))
    assert [s["section_id"] for s in fall] == ["FALL-1"]
    assert [s["section_id"] for s in spring] == ["SPRING-1"], (
        "Spring request was served Fall's cached catalog"
    )


def test_repeat_request_for_same_term_is_cached():
    clear_dept_cache()
    client = two_term_client()
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    dept_calls = [c for c in client.calls if "program" in c]
    assert len(dept_calls) == 1, f"expected cache hit, got {len(dept_calls)} fetches"


def test_lookup_section_in_cache_finds_a_section_in_its_own_term():
    clear_dept_cache()
    client = two_term_client()
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    assert lookup_section_in_cache("FALL-1", FALL) == "CSCI 270"


def test_lookup_section_in_cache_does_not_cross_terms():
    # Without a term-scoped scan this returns "CSCI 270" from Fall's entry
    # while the caller is building a Spring schedule.
    clear_dept_cache()
    client = two_term_client()
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    assert lookup_section_in_cache("FALL-1", SPRING) is None, (
        "a Fall section was found while scoped to Spring"
    )


def test_clear_dept_cache_can_drop_a_single_term():
    clear_dept_cache()
    client = two_term_client()
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    run(fetch_dept_courses("CSCI", "ENGV", client, SPRING))
    clear_dept_cache(FALL)
    assert lookup_section_in_cache("FALL-1", FALL) is None, "Fall should have been dropped"
    assert lookup_section_in_cache("SPRING-1", SPRING) == "CSCI 270", "Spring should survive"


def test_clear_dept_cache_with_no_argument_drops_everything():
    clear_dept_cache()
    client = two_term_client()
    run(fetch_dept_courses("CSCI", "ENGV", client, FALL))
    run(fetch_dept_courses("CSCI", "ENGV", client, SPRING))
    clear_dept_cache()
    assert lookup_section_in_cache("FALL-1", FALL) is None
    assert lookup_section_in_cache("SPRING-1", SPRING) is None


def test_no_module_level_term_constant_remains():
    assert not hasattr(scraper, "TERM_CODE"), (
        "TERM_CODE still exists on scraper -- term must be per-request"
    )


def test_unknown_department_returns_empty():
    clear_dept_cache()
    client = two_term_client()
    assert run(scrape_course("XXXX 100", client, {"CSCI": "ENGV"}, FALL)) == []


# ---------------------------------------------------------------------------
# Snapshot serving (U2): the /generate request path must read from the cache
# snapshot and never block on a cold USC fetch.
# ---------------------------------------------------------------------------

def test_snapshot_fresh_hit_issues_no_http():
    """A warm snapshot serves the request path with zero outbound HTTP."""
    async def _run():
        clear_dept_cache()
        client = two_term_client()
        lookup = {"CSCI": "ENGV"}
        # Warm the snapshot via the blocking (warmer) path.
        await scrape_course("CSCI 270", client, lookup, FALL, block_on_miss=True)
        calls_before = len(client.calls)
        res = await scrape_course("CSCI 270", client, lookup, FALL, block_on_miss=False)
        assert len(client.calls) == calls_before, "fresh hit must not issue HTTP"
        assert [s["section_id"] for s in res] == ["FALL-1"]
    run(_run())


def test_request_path_cold_miss_does_not_block_then_backfills():
    """
    block_on_miss=False returns [] immediately on a cold miss (no synchronous
    fetch), and the scheduled background refresh warms the cache for next time.
    """
    async def _run():
        clear_dept_cache()
        client = two_term_client()
        lookup = {"CSCI": "ENGV"}
        res = await scrape_course("CSCI 270", client, lookup, FALL, block_on_miss=False)
        assert res == [], "request path must not block-fetch on a cold miss"
        await asyncio.sleep(0.05)  # let the background refresh run
        res2 = await scrape_course("CSCI 270", client, lookup, FALL, block_on_miss=False)
        assert [s["section_id"] for s in res2] == ["FALL-1"], "backfill should warm cache"
    run(_run())


def test_stale_entry_served_immediately_and_revalidated():
    """A stale-but-present entry is returned at once and refreshed in the bg."""
    async def _run():
        clear_dept_cache()
        client = two_term_client()
        lookup = {"CSCI": "ENGV"}
        await scrape_course("CSCI 270", client, lookup, FALL, block_on_miss=True)
        key = scraper._cache_key(FALL, "ENGV", "CSCI")
        _, courses = scraper._dept_cache[key]
        scraper._dept_cache[key] = (0.0, courses)  # epoch 0 → definitely stale
        calls_before = len(client.calls)
        res = await scrape_course("CSCI 270", client, lookup, FALL, block_on_miss=False)
        assert [s["section_id"] for s in res] == ["FALL-1"], "stale copy should be served"
        await asyncio.sleep(0.05)
        assert len(client.calls) > calls_before, "stale entry should revalidate in bg"
    run(_run())


TESTS = [
    test_combined_lecture_modes_count_as_primary,
    test_cancelled_sections_are_excluded,
    test_orphan_secondary_attaches_to_every_primary,
    test_school_lookup_requests_the_term_it_was_given,
    test_fetching_two_terms_issues_two_requests,
    test_cached_term_data_is_not_served_for_another_term,
    test_repeat_request_for_same_term_is_cached,
    test_lookup_section_in_cache_finds_a_section_in_its_own_term,
    test_lookup_section_in_cache_does_not_cross_terms,
    test_clear_dept_cache_can_drop_a_single_term,
    test_clear_dept_cache_with_no_argument_drops_everything,
    test_no_module_level_term_constant_remains,
    test_unknown_department_returns_empty,
    test_snapshot_fresh_hit_issues_no_http,
    test_request_path_cold_miss_does_not_block_then_backfills,
    test_stale_entry_served_immediately_and_revalidated,
]


async def _live_smoke() -> None:
    import httpx
    from scraper import HTTP_HEADERS
    from terms import default_term, fetch_active_terms

    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True, timeout=120) as client:
        active = await fetch_active_terms(client)
        print(f"Active terms: {[t['label'] for t in active]}")
        term = default_term(active)
        school_lookup = await build_school_lookup(client, term)
        print(f"Loaded {len(school_lookup)} departments for {term}\n")
        for course_code in ["CSCI 270", "MATH 225"]:
            sections = await scrape_course(course_code, client, school_lookup, term)
            print(f"─── {course_code} ({term}) — {len(sections)} primary section(s) ───")
            for s in sections[:3]:
                print(f"  [{s['section_id']}] {s['section_type']:12} {s['professor']:28} "
                      f"{str(s['days']):18} {s['start_time']}-{s['end_time']}  "
                      f"seats={s['seats_available']}  linked={len(s.get('linked_sections', []))}")
            print()


def main() -> int:
    if "--live" in sys.argv:
        asyncio.run(_live_smoke())
        return 0

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

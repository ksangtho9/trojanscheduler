"""
test_terms.py — tests for the active-term registry.

Run: python3 test_terms.py
Exits non-zero on any failure.

No network: every test drives terms.py through a fake client so the active-set
filtering, ordering, TTL and fallback behavior are deterministic.
"""
from __future__ import annotations
import asyncio
import sys
import traceback
from datetime import date

import terms
from terms import (
    TermUnavailableError,
    clear_terms_cache,
    current_term_code,
    default_term,
    fetch_active_terms,
    parse_term_code,
    resolve_term,
    term_label,
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def make_term(code: int, status: str = "Active") -> dict:
    """One /Terms/All entry, trimmed to the fields terms.py reads."""
    return {"termCode": code, "status": status, "seasonName": "ignored"}


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self):
        return self._payload


class FakeClient:
    """Counts calls so TTL behavior is observable."""

    def __init__(self, payload, fail: bool = False):
        self.payload = payload
        self.fail = fail
        self.calls = 0

    async def get(self, url, params=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError("network down")
        return FakeResponse(self.payload)


def run(coro):
    return asyncio.run(coro)


LIVE_SHAPE = [
    make_term(20263), make_term(20262), make_term(20261),
    make_term(20253, "Archived"), make_term(20252, "Archived"),
]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_only_active_terms_are_returned():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    result = run(fetch_active_terms(client))
    codes = [t["term_code"] for t in result]
    assert codes == ["20263", "20262", "20261"], f"archived terms leaked through: {codes}"


def test_active_terms_are_ordered_newest_first():
    clear_terms_cache()
    # Deliberately out of order in the payload.
    client = FakeClient([make_term(20261), make_term(20263), make_term(20262)])
    result = run(fetch_active_terms(client))
    codes = [t["term_code"] for t in result]
    assert codes == ["20263", "20262", "20261"], f"not sorted newest-first: {codes}"


def test_default_is_the_next_term_after_the_one_in_session():
    # Students register a term ahead: during Spring, the next thing to plan is
    # Summer; during Summer, Fall.
    terms = [{"term_code": c} for c in ["20263", "20262", "20261"]]
    assert default_term(terms, date(2026, 3, 1)) == "20262", "in Spring, default to Summer"
    assert default_term(terms, date(2026, 6, 15)) == "20263", "in Summer, default to Fall"


def test_default_rolls_into_the_next_year():
    # The case that motivated this: it is Fall 2026 and USC has opened
    # Spring 2027, so that is what should be preselected.
    terms = [{"term_code": c} for c in ["20271", "20263", "20262"]]
    assert default_term(terms, date(2026, 10, 15)) == "20271"
    assert default_term(terms, date(2026, 12, 20)) == "20271"


def test_default_picks_the_earliest_upcoming_not_the_furthest():
    # With both Summer and Fall open during Spring, the *next* one wins.
    terms = [{"term_code": c} for c in ["20273", "20272", "20271"]]
    assert default_term(terms, date(2027, 2, 1)) == "20272", "should be Summer, not Fall"


def test_default_falls_back_when_no_later_term_is_published():
    # Today's real situation: it is Fall 2026 and USC has no 2027 term at all,
    # so the furthest-out active term is the only sensible preselection.
    terms = [{"term_code": c} for c in ["20263", "20262", "20261"]]
    assert default_term(terms, date(2026, 9, 11)) == "20263"


def test_current_term_code_maps_months_to_seasons():
    assert current_term_code(date(2026, 1, 15)) == "20261"
    assert current_term_code(date(2026, 4, 30)) == "20261"
    assert current_term_code(date(2026, 5, 1)) == "20262"
    assert current_term_code(date(2026, 7, 31)) == "20262"
    assert current_term_code(date(2026, 8, 1)) == "20263"
    assert current_term_code(date(2026, 12, 31)) == "20263"


def test_term_codes_map_to_readable_labels():
    assert term_label("20261") == "Spring 2026"
    assert term_label("20262") == "Summer 2026"
    assert term_label("20263") == "Fall 2026"


def test_malformed_term_codes_do_not_parse():
    for bad in ["", "fall", "999", "202634", "20264", "2026x"]:
        assert parse_term_code(bad) is None, f"{bad!r} should not parse"


def test_repeat_call_inside_ttl_does_not_refetch():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    run(fetch_active_terms(client))
    run(fetch_active_terms(client))
    assert client.calls == 1, f"expected 1 HTTP call inside TTL, got {client.calls}"


def test_call_after_ttl_expiry_refetches():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    run(fetch_active_terms(client))
    original_ttl = terms.TERMS_CACHE_TTL
    terms.TERMS_CACHE_TTL = -1  # force every entry to read as expired
    try:
        run(fetch_active_terms(client))
    finally:
        terms.TERMS_CACHE_TTL = original_ttl
    assert client.calls == 2, f"expected a refetch after TTL expiry, got {client.calls} calls"


def test_stale_list_is_served_when_usc_is_unreachable():
    clear_terms_cache()
    run(fetch_active_terms(FakeClient(LIVE_SHAPE)))  # prime the cache
    original_ttl = terms.TERMS_CACHE_TTL
    terms.TERMS_CACHE_TTL = -1
    try:
        result = run(fetch_active_terms(FakeClient(None, fail=True)))
    finally:
        terms.TERMS_CACHE_TTL = original_ttl
    codes = [t["term_code"] for t in result]
    assert codes == ["20263", "20262", "20261"], "stale cache should be served on fetch failure"


def test_cold_failure_raises():
    clear_terms_cache()
    try:
        run(fetch_active_terms(FakeClient(None, fail=True)))
    except TermUnavailableError:
        return
    raise AssertionError("a cold fetch failure must raise, not return silently")


def test_empty_active_set_raises_when_cold():
    clear_terms_cache()
    try:
        run(fetch_active_terms(FakeClient([make_term(20253, "Archived")])))
    except TermUnavailableError:
        return
    raise AssertionError("no active terms with no cache must raise")


def test_resolve_term_defaults_when_omitted():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    # Pinned date so this does not drift as real time passes.
    when = date(2026, 9, 11)
    assert run(resolve_term(None, client, when)) == "20263"
    assert run(resolve_term("", client, when)) == "20263"


def test_resolve_term_accepts_an_active_non_default_term():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    assert run(resolve_term("20261", client)) == "20261"


def test_resolve_term_rejects_an_archived_term():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    try:
        run(resolve_term("20253", client))
    except ValueError as e:
        msg = str(e)
        assert "20253" in msg, "error should name the rejected term"
        assert "20263" in msg, "error should list the valid terms"
        return
    raise AssertionError("an archived term must be rejected, not silently accepted")


def test_resolve_term_rejects_malformed_input():
    clear_terms_cache()
    client = FakeClient(LIVE_SHAPE)
    for bad in ["fall", "999", "20264"]:
        try:
            run(resolve_term(bad, client))
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} must be rejected")


TESTS = [
    test_only_active_terms_are_returned,
    test_active_terms_are_ordered_newest_first,
    test_default_is_the_next_term_after_the_one_in_session,
    test_default_rolls_into_the_next_year,
    test_default_picks_the_earliest_upcoming_not_the_furthest,
    test_default_falls_back_when_no_later_term_is_published,
    test_current_term_code_maps_months_to_seasons,
    test_term_codes_map_to_readable_labels,
    test_malformed_term_codes_do_not_parse,
    test_repeat_call_inside_ttl_does_not_refetch,
    test_call_after_ttl_expiry_refetches,
    test_stale_list_is_served_when_usc_is_unreachable,
    test_cold_failure_raises,
    test_empty_active_set_raises_when_cold,
    test_resolve_term_defaults_when_omitted,
    test_resolve_term_accepts_an_active_non_default_term,
    test_resolve_term_rejects_an_archived_term,
    test_resolve_term_rejects_malformed_input,
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

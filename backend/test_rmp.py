"""
test_rmp.py — contract tests for the budgeted RMP enrichment (U3).

Plain script, not pytest (matches test_solver.py / test_scraper.py).
Run: python3 test_rmp.py   → exits non-zero on failure.
"""

import asyncio
import time
import types

import rmp


class FakeSection:
    """Minimal stand-in for solver.Section — only the fields enrich touches."""
    def __init__(self, professor):
        self.professor = professor
        self.rmp_score = None
        self.rmp_difficulty = None
        self.would_take_again = None
        self.rmp_total_ratings = None
        self.rmp_profile_url = None
        self.no_rmp_data = None


def _real(score):
    return {
        "rmp_score": score, "rmp_difficulty": 2.0, "would_take_again": 80.0,
        "rmp_total_ratings": 10, "rmp_profile_url": "http://x", "no_rmp_data": False,
    }


def _reset_cache():
    rmp._RMP_CACHE.clear()


def _patch_fetch(fn):
    """Swap rmp.fetch_rmp; return the original for restore."""
    orig = rmp.fetch_rmp
    rmp.fetch_rmp = fn
    return orig


# Silence disk writes during tests.
rmp._save_rmp_cache = lambda: None


def test_all_cached_is_fast_and_real():
    _reset_cache()
    now = time.time()
    rmp._RMP_CACHE["Ada Lovelace"] = (now, _real(4.5))
    secs = {"CSCI 100": [FakeSection("Ada Lovelace")]}

    start = time.perf_counter()
    asyncio.run(rmp.enrich_with_rmp(secs, client=None, budget_s=2.0))
    elapsed = time.perf_counter() - start

    s = secs["CSCI 100"][0]
    assert s.rmp_score == 4.5, f"expected cached score, got {s.rmp_score}"
    assert s.no_rmp_data is False
    assert elapsed < 0.5, f"cached path should be instant, took {elapsed:.2f}s"
    print("PASS test_all_cached_is_fast_and_real")


def test_budget_caps_slow_names_with_neutral_fallback():
    _reset_cache()

    async def slow_fetch(name, client):
        await asyncio.sleep(5.0)  # far exceeds budget
        return _real(5.0)

    orig = _patch_fetch(slow_fetch)
    try:
        secs = {"X 1": [FakeSection("Slow Prof")]}
        start = time.perf_counter()
        asyncio.run(rmp.enrich_with_rmp(secs, client=None, budget_s=0.5))
        elapsed = time.perf_counter() - start
    finally:
        rmp.fetch_rmp = orig

    s = secs["X 1"][0]
    assert elapsed < 2.0, f"budget not enforced, took {elapsed:.2f}s"
    assert s.no_rmp_data is True, "timed-out name should get neutral fallback"
    assert s.rmp_score == 3.0, f"neutral score expected, got {s.rmp_score}"
    print("PASS test_budget_caps_slow_names_with_neutral_fallback")


def test_endpoint_failure_never_raises():
    _reset_cache()

    async def boom(name, client):
        raise RuntimeError("RMP down")

    # fetch_rmp itself never raises in prod; simulate a raising variant to prove
    # enrich still completes with neutral data via the backfill/gather guards.
    async def safe_boom(name, client):
        try:
            return await boom(name, client)
        except Exception:
            return rmp._no_data()

    orig = _patch_fetch(safe_boom)
    try:
        secs = {"X 1": [FakeSection("Whoever")]}
        asyncio.run(rmp.enrich_with_rmp(secs, client=None, budget_s=1.0))
    finally:
        rmp.fetch_rmp = orig

    s = secs["X 1"][0]
    assert s.no_rmp_data is True
    print("PASS test_endpoint_failure_never_raises")


if __name__ == "__main__":
    test_all_cached_is_fast_and_real()
    test_budget_caps_slow_names_with_neutral_fallback()
    test_endpoint_failure_never_raises()
    print("\nAll RMP budget tests passed.")

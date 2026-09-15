import asyncio
import base64
import json
import os
import time
import httpx
from typing import Optional

# Cross-request RMP cache. Professor ratings change very slowly (ratings only
# accumulate over a term), so caching by name with a TTL makes repeat requests
# near-instant in the RMP phase without meaningfully staling the data.
# Keyed by professor name → (fetched_at_epoch, rmp_data_dict).
# Persisted to RMP_CACHE_PATH so it survives process restarts.
_RMP_CACHE: dict[str, tuple[float, dict]] = {}
_RMP_CACHE_TTL = float(os.getenv("RMP_CACHE_TTL", str(12 * 3600)))  # seconds, default 12h

# Hard wall-clock budget for RMP enrichment on the request's critical path.
# RMP affects ranking only, never feasibility, so any professor not resolved
# within the budget falls back to neutral data for THIS response and is filled
# into the cache by a detached background task so the next request is warm.
_RMP_BUDGET_S = float(os.getenv("RMP_BUDGET_S", "2.5"))  # seconds
_RMP_CACHE_PATH = os.getenv(
    "RMP_CACHE_PATH",
    os.path.join(os.path.dirname(__file__), ".rmp_cache.json"),
)


def _load_rmp_cache() -> None:
    try:
        with open(_RMP_CACHE_PATH) as f:
            raw = json.load(f)
        now = time.time()
        for name, (ts, data) in raw.items():
            if now - ts < _RMP_CACHE_TTL:
                _RMP_CACHE[name] = (ts, data)
    except (OSError, ValueError):
        pass


def _save_rmp_cache() -> None:
    try:
        tmp = _RMP_CACHE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_RMP_CACHE, f)
        os.replace(tmp, _RMP_CACHE_PATH)
    except OSError:
        pass


_load_rmp_cache()

RMP_ENDPOINT = "https://www.ratemyprofessors.com/graphql"
RMP_AUTH = "Basic dGVzdDp0ZXN0"   # base64("test:test") — RMP's public token
USC_SCHOOL_ID = "U2Nob29sLTEwNTk="  # base64("School-1059")

_SEARCH_QUERY = """
query SearchTeachersQuery($text: String!, $schoolID: ID) {
  newSearch {
    teachers(query: {text: $text, schoolID: $schoolID}) {
      edges {
        node {
          id
          firstName
          lastName
          avgRating
          avgDifficulty
          wouldTakeAgainPercent
          numRatings
        }
      }
    }
  }
}
"""

# Global search (no schoolID filter). Used as a fallback for professors that
# RMP has tagged with a USC sub-school different from our primary schoolID.
# Result includes `school { name }` so we can filter to USC client-side.
_SEARCH_QUERY_GLOBAL = """
query SearchTeachersQuery($text: String!) {
  newSearch {
    teachers(query: {text: $text}) {
      edges {
        node {
          id
          firstName
          lastName
          avgRating
          avgDifficulty
          wouldTakeAgainPercent
          numRatings
          school { name }
        }
      }
    }
  }
}
"""

USC_SCHOOL_NAME = "University of Southern California"


def _decode_rmp_id(encoded_id: str) -> str:
    """'VGVhY2hlci0xMjM0NTY=' → '123456'"""
    try:
        return base64.b64decode(encoded_id).decode().rsplit("-", 1)[-1]
    except Exception:
        return ""


def _best_match(edges: list[dict], professor_name: str) -> Optional[dict]:
    """
    Pick the matching node from RMP results.

    Strictness rules (to avoid mapping "Jason Webb" → "Sherry Webb"):
    - Require an EXACT last-name match (not substring). "Webb" matches "Webb"
      but not "Webber".
    - When multiple candidates share the last name, require a first-name match
      to disambiguate. Accepts the queried first name appearing as a token in
      the RMP first-name field (handles middle names like "Erin M." vs "Erin").
    - If we can't pick a unique match, return None so the caller surfaces a
      "No ratings" pill instead of wrong data.
    """
    parts = professor_name.lower().split()
    if not parts:
        return None
    last = parts[-1]
    first = parts[0] if len(parts) > 1 else ""

    # Exact last-name candidates only.
    last_matches = [
        edge["node"]
        for edge in edges
        if (edge.get("node", {}).get("lastName") or "").lower() == last
    ]

    if not last_matches:
        return None

    if len(last_matches) == 1:
        return last_matches[0]

    # Multiple candidates: must disambiguate by first name.
    if not first:
        return None
    for node in last_matches:
        node_first = (node.get("firstName") or "").lower()
        if not node_first:
            continue
        # Match if RMP first name is an exact word match, a startswith on the
        # search first name + space (e.g. "Erin M." starts with "erin "), or
        # the queried first name appears as a token.
        if node_first == first or node_first.startswith(first + " ") or first in node_first.split():
            return node

    return None


def _no_data() -> dict:
    return {
        "rmp_score": 3.0,
        "rmp_difficulty": None,
        "would_take_again": None,
        "rmp_total_ratings": 0,
        "rmp_profile_url": None,
        "no_rmp_data": True,
    }


def _float_or_none(val) -> Optional[float]:
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


_RMP_HEADERS = {
    "Authorization": RMP_AUTH,
    "Content-Type": "application/json",
    "Referer": "https://www.ratemyprofessors.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}


async def _search_usc(last_name: str, client: httpx.AsyncClient) -> list[dict]:
    """Search the primary USC schoolID. Returns raw edges or []."""
    try:
        r = await client.post(
            RMP_ENDPOINT,
            json={
                "query": _SEARCH_QUERY,
                "variables": {"text": last_name, "schoolID": USC_SCHOOL_ID},
            },
            headers=_RMP_HEADERS,
            timeout=10.0,
        )
        r.raise_for_status()
        return (
            r.json()
            .get("data", {})
            .get("newSearch", {})
            .get("teachers", {})
            .get("edges", [])
        )
    except Exception:
        return []


async def _search_global_usc(query_text: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Search RMP globally (no schoolID filter) and keep only edges whose school
    is "University of Southern California". Catches professors RMP has tagged
    with a different USC school ID than our primary one.

    RMP's global search caps results at ~10 entries by relevance, so we send
    the full professor name (e.g. "Giovanni Rizzo") rather than just the last
    name. Common surnames otherwise get drowned out by other schools.
    """
    try:
        r = await client.post(
            RMP_ENDPOINT,
            json={
                "query": _SEARCH_QUERY_GLOBAL,
                "variables": {"text": query_text},
            },
            headers=_RMP_HEADERS,
            timeout=10.0,
        )
        r.raise_for_status()
        edges = (
            r.json()
            .get("data", {})
            .get("newSearch", {})
            .get("teachers", {})
            .get("edges", [])
        )
    except Exception:
        return []

    return [
        e for e in edges
        if ((e.get("node", {}).get("school") or {}).get("name") or "") == USC_SCHOOL_NAME
    ]


async def fetch_rmp(professor_name: str, client: httpx.AsyncClient) -> dict:
    """
    Fetch RMP data for one professor at USC.
    Returns a dict of rmp_* fields ready to apply to a Section.
    Always returns something safe — never raises.

    Two-tier search:
    1. Primary: USC schoolID-filtered search by last name.
    2. Fallback: global search filtered by school name = USC. Catches profs
       (e.g., Erin Kaplan) RMP has tagged with a non-primary USC school ID.
    """
    if not professor_name or professor_name == "TBA":
        return _no_data()

    parts = professor_name.strip().split()
    last_name = parts[-1]
    first_name = parts[0] if len(parts) > 1 else ""
    # The fallback search is global, so it needs a tight query to outrank
    # same-last-name candidates from other schools.
    fallback_query = f"{first_name} {last_name}".strip() if first_name else last_name

    edges = await _search_usc(last_name, client)
    node = _best_match(edges, professor_name)

    if not node:
        # Try global → USC-filtered fallback with the full first+last name.
        edges = await _search_global_usc(fallback_query, client)
        node = _best_match(edges, professor_name)

    if not node:
        return _no_data()

    numeric_id = _decode_rmp_id(node.get("id", ""))
    return {
        "rmp_score":         float(node.get("avgRating") or 3.0),
        "rmp_difficulty":    _float_or_none(node.get("avgDifficulty")),
        "would_take_again":  _float_or_none(node.get("wouldTakeAgainPercent")),
        "rmp_total_ratings": int(node.get("numRatings") or 0),
        "rmp_profile_url": (
            f"https://www.ratemyprofessors.com/professor/{numeric_id}"
            if numeric_id else None
        ),
        "no_rmp_data": False,
    }


async def fetch_rmp_scores(
    professor_names: list[str],
    client: httpx.AsyncClient,
    concurrency: int = 25,
) -> dict[str, dict]:
    """
    Fetch RMP data for a list of professor names.
    Returns {professor_name: rmp_data_dict}.
    Deduplicates automatically — one API call per unique name — and serves
    fresh-enough names from the cross-request _RMP_CACHE without re-fetching.
    """
    unique = list(set(professor_names))
    now = time.time()

    result: dict[str, dict] = {}
    to_fetch: list[str] = []
    for name in unique:
        entry = _RMP_CACHE.get(name)
        if entry is not None and now - entry[0] < _RMP_CACHE_TTL:
            result[name] = entry[1]
        else:
            to_fetch.append(name)

    semaphore = asyncio.Semaphore(concurrency)

    async def _fetch_one(name: str) -> None:
        async with semaphore:
            data = await fetch_rmp(name, client)
        result[name] = data
        _RMP_CACHE[name] = (time.time(), data)

    await asyncio.gather(*[_fetch_one(p) for p in to_fetch])
    if to_fetch:
        _save_rmp_cache()
    return result


def _apply_rmp(section, data: dict) -> None:
    section.rmp_score         = data["rmp_score"]
    section.rmp_difficulty    = data["rmp_difficulty"]
    section.would_take_again  = data["would_take_again"]
    section.rmp_total_ratings = data["rmp_total_ratings"]
    section.rmp_profile_url   = data["rmp_profile_url"]
    section.no_rmp_data        = data["no_rmp_data"]


async def _backfill_rmp(names: list[str], client: httpx.AsyncClient, concurrency: int) -> None:
    """
    Finish resolving professors that missed the request budget and write them to
    the cross-request cache, so the next request serves them instantly. Best
    effort: never raises, only warms the cache.
    """
    semaphore = asyncio.Semaphore(concurrency)

    async def _one(name: str) -> None:
        async with semaphore:
            data = await fetch_rmp(name, client)
        _RMP_CACHE[name] = (time.time(), data)

    try:
        await asyncio.gather(*[_one(n) for n in names], return_exceptions=True)
        _save_rmp_cache()
    except Exception:
        pass


async def enrich_with_rmp(
    all_sections: dict,
    client: httpx.AsyncClient,
    concurrency: int = 25,
    budget_s: float | None = None,
) -> None:
    """
    Mutates Section objects in place with RMP data, bounded by a hard wall-clock
    budget (default `_RMP_BUDGET_S`). Cached names are applied instantly; uncached
    names are fetched only until the budget elapses. Names still unresolved when
    the budget runs out get neutral `_no_data()` for this response and are filled
    into the cache by a detached background task. RMP is ranking-only, so this
    trades a slightly stale ranking on cold names for a bounded response time —
    never schedule validity.
    """
    if budget_s is None:
        budget_s = _RMP_BUDGET_S

    flat = [s for sections in all_sections.values() for s in sections]
    unique_names = list({s.professor for s in flat if s.professor not in ("TBA", "")})

    now = time.time()
    resolved: dict[str, dict] = {}
    to_fetch: list[str] = []
    for name in unique_names:
        entry = _RMP_CACHE.get(name)
        if entry is not None and now - entry[0] < _RMP_CACHE_TTL:
            resolved[name] = entry[1]
        else:
            to_fetch.append(name)

    # Fetch uncached names, but only until the budget elapses.
    if to_fetch:
        semaphore = asyncio.Semaphore(concurrency)

        async def _fetch_one(name: str) -> None:
            async with semaphore:
                data = await fetch_rmp(name, client)
            resolved[name] = data
            _RMP_CACHE[name] = (time.time(), data)

        tasks = {asyncio.create_task(_fetch_one(n)): n for n in to_fetch}
        done, pending = await asyncio.wait(tasks.keys(), timeout=budget_s)

        if pending:
            # Detach the stragglers as a background backfill; do NOT cancel them,
            # they will warm the cache for the next request.
            leftover = [tasks[t] for t in pending]
            for t in pending:
                t.cancel()
            asyncio.create_task(_backfill_rmp(leftover, client, concurrency))
        elif done:
            _save_rmp_cache()

    # Apply whatever resolved in time; everything else gets neutral data now.
    for section in flat:
        _apply_rmp(section, resolved.get(section.professor, _no_data()))

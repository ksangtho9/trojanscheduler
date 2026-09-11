"""
terms.py — active-term registry for Trojan Scheduler

USC exposes every term it has ever run at:

  /api/Terms/All
      → 80+ entries, each with a termCode and a status. Exactly the terms that
        are currently registerable carry status "Active" (as of this writing:
        Spring/Summer/Fall of the current cycle); everything older is
        "Archived".

Reading the active set from USC is what keeps the app on the current semester
without anyone editing an env var and redeploying each term. Deriving the term
from the calendar date instead would mean reimplementing USC's registration
calendar and drifting from it whenever they shift a date.

Term codes are YYYY + a season digit: 20263 = Fall 2026.
"""

import os
import time

import httpx

BASE_URL = "https://classes.usc.edu/api"

# Active terms change a handful of times a year, so this is deliberately long:
# it makes term resolution effectively free per-request while still picking up
# a rollover on its own, without a redeploy.
TERMS_CACHE_TTL = float(os.getenv("TERMS_CACHE_TTL", str(24 * 3600)))  # seconds, default 24h

_SEASONS = {"1": "Spring", "2": "Summer", "3": "Fall"}

# (fetched_at_epoch, terms) — module-level so it is shared across requests.
_terms_cache: tuple[float, list[dict]] | None = None


class TermUnavailableError(RuntimeError):
    """USC's term list could not be fetched and nothing was cached to fall back on."""


def parse_term_code(term_code) -> tuple[str, str] | None:
    """
    Split "20263" into ("2026", "Fall"). Returns None if the code isn't a
    well-formed 5-digit term code with a known season digit.

    We derive the label from the code rather than trusting the API's free-text
    seasonName so a display label exists even for a code that arrived from a
    client rather than from /Terms/All.
    """
    code = str(term_code).strip()
    if len(code) != 5 or not code.isdigit():
        return None
    season = _SEASONS.get(code[4])
    if season is None:
        return None
    return code[:4], season


def term_label(term_code) -> str:
    """"20263" → "Fall 2026". Falls back to the raw code if it can't be parsed."""
    parsed = parse_term_code(term_code)
    if parsed is None:
        return str(term_code)
    year, season = parsed
    return f"{season} {year}"


def _normalize(raw: list) -> list[dict]:
    """
    Keep only active terms, newest first.

    Sorting is by term code, which sorts correctly as a string because every
    code is the same width and the season digit ascends with the calendar.
    """
    active = []
    for entry in raw or []:
        if (entry.get("status") or "").lower() != "active":
            continue
        parsed = parse_term_code(entry.get("termCode"))
        if parsed is None:
            continue
        year, season = parsed
        code = str(entry["termCode"])
        active.append({
            "term_code": code,
            "label": f"{season} {year}",
            "season": season,
            "year": int(year),
        })
    return sorted(active, key=lambda t: t["term_code"], reverse=True)


async def fetch_active_terms(client: httpx.AsyncClient, force: bool = False) -> list[dict]:
    """
    Active terms, newest first, TTL-cached.

    If USC is unreachable but we have a previously cached list, the stale list
    is served rather than raising: a scheduler pinned to last week's term list
    is far more useful than one that 500s. Only a cold failure raises.
    """
    global _terms_cache
    if not force and _terms_cache is not None and time.time() - _terms_cache[0] < TERMS_CACHE_TTL:
        return _terms_cache[1]

    try:
        r = await client.get(f"{BASE_URL}/Terms/All")
        r.raise_for_status()
        terms = _normalize(r.json())
    except Exception as e:
        if _terms_cache is not None:
            print(f"Term list refresh failed ({e}) — serving cached terms")
            return _terms_cache[1]
        raise TermUnavailableError(f"could not fetch USC term list: {e}") from e

    if not terms:
        if _terms_cache is not None:
            print("Term list came back with no active terms — serving cached terms")
            return _terms_cache[1]
        raise TermUnavailableError("USC returned no active terms")

    _terms_cache = (time.time(), terms)
    return terms


def default_term(terms: list[dict]) -> str:
    """
    The furthest-out active term — the one a student planning ahead is most
    likely registering for. The picker makes the others reachable.
    """
    return terms[0]["term_code"]


async def resolve_term(term_code, client: httpx.AsyncClient) -> str:
    """
    Validate a caller-supplied term code against the active set, or return the
    default when none was supplied.

    Raises ValueError with the valid options for anything not currently
    registerable. Rejecting loudly matters: an unrecognized term would
    otherwise scrape an empty catalog and surface as "no schedules found",
    which reads to a student as "your constraints are too tight".
    """
    terms = await fetch_active_terms(client)
    if term_code is None or str(term_code).strip() == "":
        return default_term(terms)

    code = str(term_code).strip()
    if any(t["term_code"] == code for t in terms):
        return code

    valid = ", ".join(f"{t['term_code']} ({t['label']})" for t in terms)
    raise ValueError(f"Term {code} is not open for registration. Currently available: {valid}")


def clear_terms_cache() -> None:
    """Drop the cached term list (tests / manual invalidation)."""
    global _terms_cache
    _terms_cache = None

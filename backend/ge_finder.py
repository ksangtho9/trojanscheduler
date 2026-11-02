"""
ge_finder.py — GE candidate section fetcher for Trojan Scheduler

Uses USC's canonical GE endpoints so we get the official course list per
category instead of guessing from department prefixes.

  /api/Ge/TermCode?termCode=...
      → enumerates GE requirements + categoryPrefixes

  /api/Courses/GeCoursesByTerm?termCode=...&geRequirementPrefix=...&categoryPrefix=...
      → returns every course USC approves for that category (no sections)

We then pull sections from the existing per-dept cache so we share lookups
with the rest of the scraper.

Section dicts get two extra fields:
  - course_code: e.g. "AHIS 120"
  - ge_categories: list of category letters this course satisfies, e.g. ["A"]
"""

import asyncio
import os
import time
import httpx

from scraper import BASE_URL, fetch_dept_courses, extract_sections

# Cache for the official GE course-code lists (GeCoursesByTerm). This endpoint is
# slow (~14s cold, ~2s warm) and was the dominant cost of a GE request, yet the
# approved course list for a category barely changes within a term — so it gets
# a long TTL and the same serve-stale-while-revalidate / non-blocking treatment
# as the dept cache. Keyed "TERM:CATEGORY" → (fetched_at_epoch, codes_list).
_GE_CODES_TTL = float(os.getenv("GE_CODES_TTL", "3600"))  # seconds, default 1h
_ge_codes_cache: dict[str, tuple[float, list[str]]] = {}
_ge_codes_inflight: set[str] = set()

# Full course objects (with sections) from GeCoursesByTerm, keyed term → code.
# Needed for GE-only prefixes like GESM: they aren't in /Programs/TermCode, so
# there is no school to fetch their department with, and this response is the
# only place their sections appear. Refreshed whenever the code lists are.
_ge_course_objects: dict[str, dict[str, dict]] = {}


# Letter → (geRequirementPrefix, categoryPrefix) on USC's official map.
# Source: /api/Ge/TermCode → Fall2015OrLater group.
#
# Hardcoded rather than fetched because it does not vary by term: the
# /api/Ge/TermCode response is byte-identical across every currently-active
# term once the echoed termCode field is removed (verified 2026-09-11). If USC
# ever revises the GE requirements for a future term, this map is what needs
# revisiting — the category letters below are the app's own stable handles.
# GESM (General Education Seminar) is exposed as its own category here so the
# scheduler can treat it like A–H.
CATEGORY_PREFIX_MAP: dict[str, tuple[str, str]] = {
    "A":    ("ACORELIT", "ARTS"),
    "B":    ("ACORELIT", "HINQ"),
    "C":    ("ACORELIT", "SANA"),
    "D":    ("ACORELIT", "LIFE"),
    "E":    ("ACORELIT", "PSC"),
    "F":    ("ACORELIT", "QREA"),
    "G":    ("AGLOPERS", "GPG"),
    "H":    ("AGLOPERS", "GPH"),
    "GESM": ("ACORELIT", "GESM"),
}


def _normalize_cat(cat: str) -> str:
    """Accept 'a', 'A', 'gesm', 'GESM' — return the canonical key."""
    c = (cat or "").strip().upper()
    return c if c in CATEGORY_PREFIX_MAP else c


ALL_CLASS_LEVELS = {"U1", "U2", "U3", "U4"}  # Freshman through Senior


def is_enrollment_limited(course: dict | None) -> bool:
    """
    True if USC only opens this course to certain students: some class levels
    (GESM 1xx is freshmen-only, SOCI 242 juniors and seniors), or a major or
    school (ACAD 181 is Iovine and Young Academy only).

    Only "Inclusive" rules count. A "not open to X" rule leaves most students
    able to enroll. A course listing all four levels (BUAD 310) is open to all.
    """
    if not course:
        return False

    def inclusive(key: str) -> list[dict]:
        return [r for r in (course.get(key) or []) if r.get("restrictionCode") == "I"]

    levels = {r.get("groupCode") for r in inclusive("courseRestrictions")}
    if levels and not ALL_CLASS_LEVELS <= levels:
        return True
    return bool(inclusive("majorRestrictions") or inclusive("schoolRestrictions"))


async def _fetch_ge_codes_from_usc(
    req_prefix: str, cat_prefix: str, client: httpx.AsyncClient, term_code: str
) -> list[str]:
    r = await client.get(
        f"{BASE_URL}/Courses/GeCoursesByTerm",
        params={
            "termCode": term_code,
            "geRequirementPrefix": req_prefix,
            "categoryPrefix": cat_prefix,
        },
    )
    r.raise_for_status()
    data = r.json() or {}
    courses = data.get("courses") or []

    seen: set[str] = set()
    codes: list[str] = []
    objects = _ge_course_objects.setdefault(term_code, {})
    for c in courses:
        code = (c.get("fullCourseName") or "").strip().upper()
        if code and code not in seen:
            seen.add(code)
            codes.append(code)
            objects[code] = c
    return codes


async def _refresh_ge_codes_bg(
    cache_key: str, req_prefix: str, cat_prefix: str,
    client: httpx.AsyncClient, term_code: str,
) -> None:
    try:
        codes = await _fetch_ge_codes_from_usc(req_prefix, cat_prefix, client, term_code)
        _ge_codes_cache[cache_key] = (time.time(), codes)
    except Exception:
        pass
    finally:
        _ge_codes_inflight.discard(cache_key)


def _schedule_ge_codes_refresh(
    cache_key: str, req_prefix: str, cat_prefix: str,
    client: httpx.AsyncClient, term_code: str,
) -> None:
    if cache_key in _ge_codes_inflight:
        return
    _ge_codes_inflight.add(cache_key)
    try:
        asyncio.create_task(
            _refresh_ge_codes_bg(cache_key, req_prefix, cat_prefix, client, term_code)
        )
    except RuntimeError:
        _ge_codes_inflight.discard(cache_key)


async def fetch_ge_course_codes(
    category: str,
    client: httpx.AsyncClient,
    term_code: str,
    block_on_miss: bool = True,
) -> list[str]:
    """
    Every USC-approved course code for one GE category letter (e.g. "AHIS 120"),
    deduplicated, served from a TTL cache (see _GE_CODES_TTL).

    Cache semantics mirror the dept snapshot: fresh → return; stale → return the
    stale list and refresh in the background; cold → block-and-fetch for the
    warmer (block_on_miss=True) or return [] + background fill on the /generate
    request path (block_on_miss=False), so a request never eats the ~14s cold
    GeCoursesByTerm call.
    """
    key = _normalize_cat(category)
    mapping = CATEGORY_PREFIX_MAP.get(key)
    if not mapping:
        return []
    req_prefix, cat_prefix = mapping

    cache_key = f"{term_code}:{key}"
    entry = _ge_codes_cache.get(cache_key)
    now = time.time()

    if entry is not None and now - entry[0] < _GE_CODES_TTL:
        return entry[1]

    if entry is not None:
        _schedule_ge_codes_refresh(cache_key, req_prefix, cat_prefix, client, term_code)
        return entry[1]

    if not block_on_miss:
        _schedule_ge_codes_refresh(cache_key, req_prefix, cat_prefix, client, term_code)
        return []

    codes = await _fetch_ge_codes_from_usc(req_prefix, cat_prefix, client, term_code)
    _ge_codes_cache[cache_key] = (time.time(), codes)
    return codes


# GE-only prefixes (no department in /Programs/TermCode) → the GE category that
# lists them. Their sections exist only in that category's GeCoursesByTerm feed.
GE_ONLY_PREFIX_CATEGORY: dict[str, str] = {"GESM": "GESM"}


async def ge_only_course_sections(
    code: str, client: httpx.AsyncClient, term_code: str
) -> list[dict] | None:
    """
    Sections for a course whose prefix has no department (GESM), read from the
    GE listing. Returns None when the prefix isn't GE-only (caller should use
    the normal department path), [] when the course isn't offered.
    """
    parts = code.split()
    category = GE_ONLY_PREFIX_CATEGORY.get(parts[0]) if parts else None
    if not category:
        return None
    objects = _ge_course_objects.get(term_code, {})
    if code not in objects:
        await fetch_ge_course_codes(category, client, term_code, block_on_miss=True)
        objects = _ge_course_objects.get(term_code, {})
        if code not in objects:
            # A cached code list doesn't refill the objects; fetch the listing directly
            req_prefix, cat_prefix = CATEGORY_PREFIX_MAP[category]
            await _fetch_ge_codes_from_usc(req_prefix, cat_prefix, client, term_code)
            objects = _ge_course_objects.get(term_code, {})
    course = objects.get(code)
    return extract_sections(course) if course else []


async def warm_ge_departments(
    school_lookup: dict[str, str],
    client: httpx.AsyncClient,
    term_code: str,
    concurrency: int = 16,
) -> int:
    """
    Prefetch the department catalogs behind every GE category into the dept
    cache so /generate requests with GE slots never pay the cold-fetch cost.
    Returns the number of departments fetched (for logging).
    """
    # The warmer's job is to refresh, so it always fetches the GE code lists
    # fresh (bypassing the read-cache) and repopulates the request-path cache.
    async def _warm_codes(cat: str) -> list[str]:
        key = _normalize_cat(cat)
        mapping = CATEGORY_PREFIX_MAP.get(key)
        if not mapping:
            return []
        req_prefix, cat_prefix = mapping
        codes = await _fetch_ge_codes_from_usc(req_prefix, cat_prefix, client, term_code)
        _ge_codes_cache[f"{term_code}:{key}"] = (time.time(), codes)
        return codes

    code_lists = await asyncio.gather(*[
        _warm_codes(cat) for cat in CATEGORY_PREFIX_MAP
    ], return_exceptions=True)

    depts: set[str] = set()
    for codes in code_lists:
        if isinstance(codes, Exception):
            continue
        for code in codes:
            parts = code.split()
            if len(parts) >= 2:
                depts.add(parts[0])

    semaphore = asyncio.Semaphore(concurrency)

    async def _fetch(dept: str) -> None:
        school = school_lookup.get(dept)
        if not school:
            return
        async with semaphore:
            try:
                await fetch_dept_courses(dept, school, client, term_code)
            except Exception:
                pass

    await asyncio.gather(*[_fetch(d) for d in depts])
    return len(depts)


async def build_ge_candidates(
    categories: list[str],
    school_lookup: dict[str, str],
    client: httpx.AsyncClient,
    term_code: str,
    concurrency: int = 16,
    block_on_miss: bool = True,
) -> dict[str, list[dict]]:
    """
    Build GE candidate pools for the requested category letters.

    Returns: {"Category D": [section_dict, ...], "Category GESM": [...], ...}

    Each section_dict matches scraper output format plus:
      - course_code (str)
      - ge_categories (list[str])  → all categories that course satisfies
                                     (a course in multiple GE lists gets all of them,
                                      which feeds is_double_count in the solver).
      - enrollment_limited (bool)  → USC limits it by class level, major or school,
                                     so the solver won't auto-pick it (see solver
                                     prepare_ge_pairs).

    Implementation:
      1. Hit the official GE endpoint per requested category to get course codes.
      2. Group those codes by department prefix.
      3. Fetch each unique dept once (cached) and extract the matching sections.
    """
    if not categories:
        return {}

    # Normalize and dedupe requested categories
    requested = []
    seen_cats: set[str] = set()
    for cat in categories:
        norm = _normalize_cat(cat)
        if norm in CATEGORY_PREFIX_MAP and norm not in seen_cats:
            seen_cats.add(norm)
            requested.append(norm)

    if not requested:
        return {}

    # 1. Pull canonical course code lists in parallel
    code_lists = await asyncio.gather(*[
        fetch_ge_course_codes(cat, client, term_code, block_on_miss) for cat in requested
    ])
    cat_codes: dict[str, list[str]] = dict(zip(requested, code_lists))

    # 2. Build course_code -> set of categories that include it
    code_to_cats: dict[str, set[str]] = {}
    for cat, codes in cat_codes.items():
        for code in codes:
            code_to_cats.setdefault(code, set()).add(cat)

    # 3. Group codes by dept prefix so we can fetch each dept once
    dept_to_codes: dict[str, set[str]] = {}
    for code in code_to_cats:
        parts = code.split()
        if len(parts) < 2:
            continue
        dept = parts[0]
        dept_to_codes.setdefault(dept, set()).add(code)

    semaphore = asyncio.Semaphore(concurrency)

    async def _scan_dept(dept: str, wanted: set[str]) -> list[tuple[str, list[dict]]]:
        """Return [(course_code, sections), ...] for the wanted courses in this dept."""
        school = school_lookup.get(dept)
        if not school:
            # GE-only prefix (GESM): no department to fetch, so use the sections
            # that came with the GE listing itself.
            objects = _ge_course_objects.get(term_code, {})
            results: list[tuple[str, list[dict]]] = []
            for code in sorted(wanted):
                course = objects.get(code)
                sections = extract_sections(course) if course else []
                if sections:
                    results.append((code, sections))
            return results
        async with semaphore:
            try:
                courses = await fetch_dept_courses(
                    dept, school, client, term_code, block_on_miss
                )
            except Exception:
                return []

        results: list[tuple[str, list[dict]]] = []
        for course in courses:
            code = (course.get("fullCourseName") or "").strip().upper()
            if code not in wanted:
                continue
            sections = extract_sections(course)
            if sections:
                results.append((code, sections))
        return results

    dept_results = await asyncio.gather(*[
        _scan_dept(dept, codes) for dept, codes in dept_to_codes.items()
    ])

    # 4. Bucket sections per requested category, deduplicating by section_id
    output: dict[str, list[dict]] = {f"Category {cat}": [] for cat in requested}
    seen_ids: dict[str, set[str]] = {k: set() for k in output}

    for dept_entries in dept_results:
        for code, sections in dept_entries:
            cats_for_code = sorted(code_to_cats.get(code, set()))
            if not cats_for_code:
                continue
            limited = is_enrollment_limited(_ge_course_objects.get(term_code, {}).get(code))
            for section in sections:
                section["course_code"] = code
                section["ge_categories"] = cats_for_code
                section["enrollment_limited"] = limited
                sid = section.get("section_id", "")
                for cat in cats_for_code:
                    slot = f"Category {cat}"
                    if slot not in output:
                        continue
                    if sid and sid in seen_ids[slot]:
                        continue
                    seen_ids[slot].add(sid)
                    output[slot].append(section)

    return output

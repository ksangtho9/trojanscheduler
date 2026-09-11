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
import httpx

from scraper import BASE_URL, fetch_dept_courses, extract_sections


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


async def fetch_ge_course_codes(
    category: str,
    client: httpx.AsyncClient,
    term_code: str,
) -> list[str]:
    """
    Fetch every USC-approved course code for one GE category letter
    via the official catalogue endpoint.

    Returns full course codes like "AHIS 120", deduplicated.
    """
    key = _normalize_cat(category)
    mapping = CATEGORY_PREFIX_MAP.get(key)
    if not mapping:
        return []
    req_prefix, cat_prefix = mapping

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
    for c in courses:
        code = (c.get("fullCourseName") or "").strip().upper()
        if code and code not in seen:
            seen.add(code)
            codes.append(code)
    return codes


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
    code_lists = await asyncio.gather(*[
        fetch_ge_course_codes(cat, client, term_code) for cat in CATEGORY_PREFIX_MAP
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
) -> dict[str, list[dict]]:
    """
    Build GE candidate pools for the requested category letters.

    Returns: {"Category D": [section_dict, ...], "Category GESM": [...], ...}

    Each section_dict matches scraper output format plus:
      - course_code (str)
      - ge_categories (list[str])  → all categories that course satisfies
                                     (a course in multiple GE lists gets all of them,
                                      which feeds is_double_count in the solver).

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
        fetch_ge_course_codes(cat, client, term_code) for cat in requested
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
            return []
        async with semaphore:
            try:
                courses = await fetch_dept_courses(dept, school, client, term_code)
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
            for section in sections:
                section["course_code"] = code
                section["ge_categories"] = cats_for_code
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

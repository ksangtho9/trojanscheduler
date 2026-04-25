"""
ge_finder.py — GE candidate section fetcher for Trojan Scheduler

USC API does not expose a GE-filtered courses endpoint, so we scan departments
known to offer courses for each category (Fall2015OrLater GE system).

geCode >= 32 (bit 5 set) means the course is approved for the new GE system.
The specific category (A–H) is determined by the department prefix, not geCode.

Returns section dicts (scraper format) with two extra fields:
  - course_code: e.g. "BISC 100"
  - ge_categories: list of category letters this course satisfies, e.g. ["D"]
"""

import asyncio
import httpx
from scraper import fetch_dept_courses, extract_sections

# Category letter → USC department prefixes that primarily offer qualifying courses
CATEGORY_DEPTS: dict[str, list[str]] = {
    "A": ["ARHI", "ARLT", "ARTS", "CINE", "CNTV", "CRTW", "DANC",
          "FA", "MUS", "MUSC", "THTR", "TPVP"],
    "B": ["CLAS", "COLT", "ENGL", "FREN", "GERM", "ITAL", "LING",
          "PHIL", "PORT", "REL", "SPAN", "WRIT"],
    "C": ["AMST", "ANTH", "COMM", "ECON", "GEOG", "HIST", "IR",
          "POSC", "PSYC", "SOCI", "SOWK", "GERO"],
    "D": ["BIOC", "BISC", "BMSC", "MASC", "MICB", "NEUR"],
    "E": ["ASTR", "CHEM", "ENST", "ERTH", "GEOL", "PHYS"],
    "F": ["CSCI", "CSGM", "DSCI", "ITP", "MATH", "STAT"],
    "G": ["ANTH", "GEOG", "HIST", "IR", "LING", "POSC", "REL", "SOCI"],
    "H": ["ANTH", "GEOG", "HIST", "IR", "LING", "POSC", "REL", "SOCI"],
}

# Courses satisfying 2+ categories get is_double_count=True in the solver.
# These are cross-listed departments we know appear in multiple categories.
_MULTI_CATEGORY_DEPTS: dict[str, list[str]] = {
    "HIST": ["C", "G"],
    "IR":   ["C", "G"],
    "GEOG": ["C", "G"],
    "PHIL": ["B", "C"],
    "REL":  ["B", "G"],
    "LING": ["B", "G"],
}


def _dept_categories(dept: str, requested_category: str) -> list[str]:
    """
    Return all GE categories a given department contributes to,
    starting with the requested one.
    """
    multi = _MULTI_CATEGORY_DEPTS.get(dept)
    if multi:
        return multi
    return [requested_category]


async def _scan_dept(
    dept: str,
    school: str,
    category: str,
    client: httpx.AsyncClient,
) -> list[dict]:
    """
    Fetch all open GE-eligible sections from one department.
    Returns section dicts augmented with course_code and ge_categories.
    """
    try:
        courses = await fetch_dept_courses(dept, school, client)
    except Exception:
        return []

    result = []
    for course in courses:
        gc = course.get("geCode")
        if not gc:
            continue
        try:
            if int(gc) < 32:    # bit 5 not set → old GE system only, skip
                continue
        except (ValueError, TypeError):
            continue

        course_code = (course.get("fullCourseName") or "").strip()
        if not course_code:
            continue

        ge_cats = _dept_categories(dept, category)
        sections = extract_sections(course)

        for section in sections:
            section["course_code"] = course_code
            section["ge_categories"] = ge_cats

        result.extend(sections)

    return result


async def build_ge_candidates(
    categories: list[str],
    school_lookup: dict[str, str],
    client: httpx.AsyncClient,
    concurrency: int = 8,
) -> dict[str, list[dict]]:
    """
    Build GE candidate pools for the requested category letters.

    Returns: {"Category D": [section_dict, ...], "Category F": [...], ...}

    Each section_dict matches scraper output format plus:
      - course_code (str)
      - ge_categories (list[str])

    Scans departments in parallel, uses the scraper's per-request dept cache.
    """
    if not categories:
        return {}

    # Collect (dept, category) pairs to scan, deduplicating depts
    dept_jobs: dict[str, str] = {}  # dept → primary category (for logging)
    for cat in categories:
        for dept in CATEGORY_DEPTS.get(cat.upper(), []):
            if dept not in dept_jobs:
                dept_jobs[dept] = cat

    semaphore = asyncio.Semaphore(concurrency)
    dept_results: dict[str, list[dict]] = {}

    async def _fetch(dept: str, cat: str) -> None:
        school = school_lookup.get(dept)
        if not school:
            return
        async with semaphore:
            sections = await _scan_dept(dept, school, cat, client)
        dept_results[dept] = sections

    await asyncio.gather(*[_fetch(d, c) for d, c in dept_jobs.items()])

    # Group sections by category
    output: dict[str, list[dict]] = {f"Category {cat.upper()}": [] for cat in categories}
    seen_section_ids: dict[str, set] = {k: set() for k in output}

    for dept, sections in dept_results.items():
        for section in sections:
            for cat in section.get("ge_categories", []):
                slot = f"Category {cat.upper()}"
                if slot not in output:
                    continue
                sid = section.get("section_id", "")
                if sid and sid not in seen_section_ids[slot]:
                    seen_section_ids[slot].add(sid)
                    output[slot].append(section)

    return output

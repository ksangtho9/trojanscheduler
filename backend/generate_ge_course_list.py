"""
Generates frontend/public/ge_courses.<termCode>.json mapping each USC
General Education category to its qualifying courses, per active term.

Pulls the canonical list straight from USC's GE endpoint
(/api/Courses/GeCoursesByTerm) so the dropdown the user sees matches the
official catalogue. GESM is included as its own pseudo-category.

Run from the backend directory with the venv active:
    python generate_ge_course_list.py                # every active term
    python generate_ge_course_list.py --term 20261   # just one term

Writes one file per term: frontend/public/ge_courses.<termCode>.json.
"""

import asyncio
import json
import os
import sys

import httpx

from scraper import BASE_URL, HTTP_HEADERS
from ge_finder import CATEGORY_PREFIX_MAP
from terms import fetch_active_terms, term_label

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "public")


def out_path(term_code: str) -> str:
    return os.path.join(PUBLIC_DIR, f"ge_courses.{term_code}.json")


CONCURRENCY = 3
MAX_RETRIES = 4


async def fetch_category(
    letter: str,
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    term_code: str,
) -> list[dict]:
    req_prefix, cat_prefix = CATEGORY_PREFIX_MAP[letter]
    params = {
        "termCode": term_code,
        "geRequirementPrefix": req_prefix,
        "categoryPrefix": cat_prefix,
    }
    data: dict = {}
    async with sem:
        for attempt in range(MAX_RETRIES):
            try:
                r = await client.get(f"{BASE_URL}/Courses/GeCoursesByTerm", params=params)
                r.raise_for_status()
                data = r.json() or {}
                break
            except Exception as e:
                if attempt == MAX_RETRIES - 1:
                    print(f"  FAILED GE {letter}: {e}")
                    return []
                await asyncio.sleep(1.5 * (attempt + 1))
    courses = data.get("courses") or []

    seen: set[str] = set()
    out: list[dict] = []
    for c in courses:
        code = (c.get("fullCourseName") or "").strip().upper()
        if not code or code in seen:
            continue
        seen.add(code)
        title = (c.get("name") or c.get("description") or "").strip()
        units_raw = c.get("courseUnits") or []
        units = units_raw[0] if units_raw else None
        out.append({"code": code, "title": title, "units": units})
    out.sort(key=lambda x: x["code"])
    return out


async def generate_for_term(term_code: str, client: httpx.AsyncClient) -> None:
    letters = list(CATEGORY_PREFIX_MAP.keys())  # A..H plus GESM
    print(f"\n=== {term_label(term_code)} ({term_code}) ===")
    print(f"Fetching {len(letters)} GE categories from USC...")

    sem = asyncio.Semaphore(CONCURRENCY)
    per_cat = await asyncio.gather(*[
        fetch_category(l, client, sem, term_code) for l in letters
    ])
    results = dict(zip(letters, per_cat))

    print("Totals per category:")
    for letter in letters:
        print(f"  GE {letter}: {len(results[letter])} courses")
    print(f"Total entries (sum across cats): {sum(len(v) for v in results.values())}")

    path = out_path(term_code)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(results, f, separators=(",", ":"))
    print(f"Written to {path}")


async def main():
    requested = None
    if "--term" in sys.argv:
        requested = sys.argv[sys.argv.index("--term") + 1]

    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
        if requested:
            term_codes = [requested]
        else:
            active = await fetch_active_terms(client)
            term_codes = [t["term_code"] for t in active]
            print(f"Active terms: {', '.join(term_label(c) for c in term_codes)}")

        for code in term_codes:
            await generate_for_term(code, client)


if __name__ == "__main__":
    asyncio.run(main())

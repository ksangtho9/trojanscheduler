"""
One-time script — generates frontend/public/courses.json
Fetches all courses across all USC departments using the existing scraper infrastructure.
Run from the backend directory with the venv active:
    python generate_course_list.py                  # every active term
    python generate_course_list.py --term 20261     # just one term
    python generate_course_list.py --force          # overwrite even if a total shrinks

Writes one file per term: frontend/public/courses.<termCode>.json. The term
suffix is what lets the term picker offer three terms without the autocomplete
describing the wrong semester.

Why sequential + long timeout:
  The USC API is very slow for some departments (e.g. DSO ~110s) and returns
  TRUNCATED course lists under concurrent load with no error. A concurrent run
  therefore silently undercounts (DSO dropped to 1, CSCI 80→54, etc.). Fetching
  one department at a time with a generous timeout returns the true counts.
"""

import asyncio
import json
import os
import sys
from collections import Counter

import httpx
from scraper import build_school_lookup, HTTP_HEADERS, BASE_URL
from terms import fetch_active_terms, term_label

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "public")


def out_path(term_code: str) -> str:
    return os.path.join(PUBLIC_DIR, f"courses.{term_code}.json")
MAX_RETRIES = 4
# DSO's endpoint can take ~110s; give read plenty of headroom.
TIMEOUT = httpx.Timeout(connect=15.0, read=180.0, write=15.0, pool=180.0)
REQUEST_DELAY = 0.3   # polite gap between sequential requests


async def fetch_dept_courses(
    dept: str, school: str, client: httpx.AsyncClient, term_code: str
) -> list[dict]:
    """
    Fetch one department's courses. Retries on both errors AND empty results —
    an empty payload is often a load/slowness artifact rather than a truly empty
    department, so we give it a few more tries before accepting [].
    """
    for attempt in range(MAX_RETRIES):
        try:
            r = await client.get(
                f"{BASE_URL}/Courses/CoursesByTermSchoolProgram",
                params={"termCode": term_code, "school": school, "program": dept},
                timeout=TIMEOUT,
            )
            r.raise_for_status()
            courses = r.json().get("courses") or []
            if courses:
                return courses
            # Empty — retry (with backoff) in case it's a transient truncation.
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(1.0 * (attempt + 1))
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(1.5 * (attempt + 1))  # back off between retries
            else:
                print(f"  FAILED {dept}: {e}")
                return []
    return []  # genuinely (or persistently) empty


async def generate_for_term(term_code: str, client: httpx.AsyncClient, force: bool) -> bool:
    """Build one term's course list. Returns True if a file was written."""
    OUT_PATH = out_path(term_code)
    print(f"\n=== {term_label(term_code)} ({term_code}) ===")
    print("Building school lookup...")
    school_lookup = await build_school_lookup(client, term_code)
    print(f"  {len(school_lookup)} departments found")

    items = sorted(school_lookup.items())
    print(f"Fetching courses for {len(items)} departments SEQUENTIALLY (slow but reliable)...")

    courses: list[dict] = []
    seen: set[str] = set()
    empties: list[str] = []

    for done, (dept, school) in enumerate(items, start=1):
        dept_courses = await fetch_dept_courses(dept, school, client, term_code)
        if not dept_courses:
            empties.append(dept)

        for c in dept_courses:
            prefix = (c.get("prefix") or "").strip().upper()
            number = (c.get("classNumber") or "").strip()
            title = (c.get("name") or "").strip()
            if not prefix or not number:
                continue
            code = f"{prefix} {number}"
            units_raw = c.get("courseUnits") or []
            units = units_raw[0] if units_raw else None
            if code not in seen:
                seen.add(code)
                courses.append({"code": code, "title": title, "units": units})

        if done % 25 == 0:
            print(f"  {done}/{len(items)} departments done, {len(courses)} courses so far")

        await asyncio.sleep(REQUEST_DELAY)

    courses.sort(key=lambda c: c["code"])
    new_total = len(courses)

    # --- Regression guard + report -------------------------------------
    old: list[dict] = []
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            old = []
    old_total = len(old)

    new_pre = Counter(c["code"].split()[0] for c in courses)
    old_pre = Counter(c["code"].split()[0] for c in old)
    lost = {
        p: (old_pre[p], new_pre.get(p, 0))
        for p in old_pre
        if new_pre.get(p, 0) < old_pre[p]
    }

    print("\n" + "=" * 60)
    print(f"Total unique courses: {new_total}  (previous file: {old_total}, delta {new_total - old_total:+d})")
    print(f"Departments returning EMPTY: {len(empties)}")
    if empties:
        print(f"  {sorted(empties)}")
    if lost:
        print(f"Prefixes that LOST courses vs the existing file ({len(lost)}):")
        for p, (o, n) in sorted(lost.items()):
            print(f"  {p}: {o} -> {n}")
    else:
        print("No prefix lost courses vs the existing file.")
    print("=" * 60)

    if new_total < old_total and not force:
        print(
            f"\nREFUSING to overwrite: new total ({new_total}) < existing ({old_total}).\n"
            f"This usually means some department fetches failed. Re-run, or pass --force "
            f"(or FORCE=1) to overwrite anyway."
        )
        return False

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(courses, f, separators=(",", ":"))

    print(f"\nWritten to {OUT_PATH}")



async def main():
    force = "--force" in sys.argv or os.getenv("FORCE") == "1"

    requested = None
    if "--term" in sys.argv:
        requested = sys.argv[sys.argv.index("--term") + 1]

    async with httpx.AsyncClient(
        headers=HTTP_HEADERS, follow_redirects=True, timeout=TIMEOUT
    ) as client:
        if requested:
            term_codes = [requested]
        else:
            active = await fetch_active_terms(client)
            term_codes = [t["term_code"] for t in active]
            print(f"Active terms: {', '.join(term_label(c) for c in term_codes)}")

        # Sequential across terms for the same reason it is sequential across
        # departments: the USC API silently truncates under concurrent load.
        written, skipped = [], []
        for code in term_codes:
            if await generate_for_term(code, client, force):
                written.append(code)
            else:
                skipped.append(code)

        print("\n" + "=" * 60)
        print(f"Wrote {len(written)} file(s): {', '.join(written) or 'none'}")
        if skipped:
            print(f"Skipped (shrink guard): {', '.join(skipped)} — re-run or pass --force")
        print("=" * 60)
        return 1 if skipped and not force else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

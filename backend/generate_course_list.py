"""
One-time script — generates frontend/public/courses.json
Fetches all courses across all USC departments using the existing scraper infrastructure.
Run from the backend directory with the venv active:
    python generate_course_list.py
"""

import asyncio
import json
import os
import httpx
from scraper import build_school_lookup, HTTP_HEADERS, BASE_URL, TERM_CODE

OUT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "frontend", "public", "courses.json"
)
CONCURRENCY = 5      # low enough to avoid USC API rate limiting
MAX_RETRIES = 3


async def fetch_dept_courses(dept: str, school: str, client: httpx.AsyncClient) -> list[dict]:
    for attempt in range(MAX_RETRIES):
        try:
            r = await client.get(
                f"{BASE_URL}/Courses/CoursesByTermSchoolProgram",
                params={"termCode": TERM_CODE, "school": school, "program": dept},
                timeout=20,
            )
            r.raise_for_status()
            return r.json().get("courses") or []
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(1.5 * (attempt + 1))  # back off between retries
            else:
                print(f"  FAILED {dept}: {e}")
    return []


async def main():
    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
        print("Building school lookup...")
        school_lookup = await build_school_lookup(client)
        print(f"  {len(school_lookup)} departments found")

        sem = asyncio.Semaphore(CONCURRENCY)

        async def fetch_one(dept: str, school: str):
            async with sem:
                result = await fetch_dept_courses(dept, school, client)
                return dept, school, result

        tasks = [fetch_one(dept, school) for dept, school in school_lookup.items()]
        print(f"Fetching courses for {len(tasks)} departments (concurrency={CONCURRENCY})...")

        courses: list[dict] = []
        seen: set[str] = set()
        done = 0

        for coro in asyncio.as_completed(tasks):
            dept, school, dept_courses = await coro
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(tasks)} departments done, {len(courses)} courses so far")

            for c in dept_courses:
                prefix = (c.get("prefix") or "").strip().upper()
                number = (c.get("classNumber") or "").strip()
                title = (c.get("name") or "").strip()
                if not prefix or not number:
                    continue
                code = f"{prefix} {number}"
                if code not in seen:
                    seen.add(code)
                    courses.append({"code": code, "title": title})

        courses.sort(key=lambda c: c["code"])
        print(f"\nTotal unique courses: {len(courses)}")

        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump(courses, f, separators=(",", ":"))

        print(f"Written to {OUT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())

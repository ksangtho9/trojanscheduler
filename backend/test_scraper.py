import asyncio
import json
import httpx
from scraper import build_school_lookup, scrape_course, HTTP_HEADERS

async def main():
    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
        print("Building school lookup...")
        school_lookup = await build_school_lookup(client)
        print(f"Loaded {len(school_lookup)} departments\n")

        for course_code in ["CSCI 270", "CSCI 100", "MATH 225"]:
            print(f"─── {course_code} ───")
            sections = await scrape_course(course_code, client, school_lookup)
            print(f"  {len(sections)} primary section(s) found")
            for s in sections[:3]:
                linked = s.get("linked_sections", [])
                print(f"  [{s['section_id']}] {s['section_type']:12} {s['professor']:30} "
                      f"{str(s['days']):20} {s['start_time']}-{s['end_time']}  "
                      f"seats={s['seats_available']}  linked={len(linked)}")
                for ls in linked[:2]:
                    print(f"    └─ [{ls['section_id']}] {ls['section_type']:12} "
                          f"{str(ls['days']):20} {ls['start_time']}-{ls['end_time']}  "
                          f"seats={ls['seats_available']}")
            print()

asyncio.run(main())

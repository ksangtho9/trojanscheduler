import httpx

TERM_CODE = "20263"  # Fall 2026 — update each semester
BASE_URL = "https://classes.usc.edu/api"

HTTP_HEADERS = {
    "Accept": "application/json",
    "Referer": "https://classes.usc.edu/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

LECTURE_MODES = {"Lecture", "Seminar", "Activity", "Workshop", "Screening"}

MODALITY_MAP = {
    "Lecture":    "in_person",
    "Discussion": "in_person",
    "Lab":        "in_person",
    "Quiz":       "in_person",
    "Seminar":    "in_person",
    "Activity":   "in_person",
    "Workshop":   "in_person",
    "Screening":  "in_person",
    "Online":     "online",
    "Hybrid":     "hybrid",
}


async def build_school_lookup(client: httpx.AsyncClient) -> dict[str, str]:
    """
    Returns {dept_prefix: school_prefix}, e.g. {"CSCI": "ENGV", "MATH": "DORS"}.
    Called once at startup and cached on the app state.
    """
    r = await client.get(f"{BASE_URL}/Programs/TermCode", params={"termCode": TERM_CODE})
    r.raise_for_status()
    programs = r.json()
    lookup: dict[str, str] = {}
    for prog in programs:
        dept = prog.get("prefix")
        schools = prog.get("schools") or []
        if dept and schools:
            lookup[dept] = schools[0]["prefix"]
    return lookup


def _parse_section(sec: dict, is_secondary: bool = False) -> dict:
    schedule = (sec.get("schedule") or [{}])[0]
    instructors = sec.get("instructors") or []
    if instructors:
        p = instructors[0]
        professor = f"{p.get('firstName', '')} {p.get('lastName', '')}".strip()
    else:
        professor = "TBA"

    units_raw = sec.get("units") or ["0"]
    try:
        units = float(units_raw[0])
    except (ValueError, IndexError):
        units = 0.0

    total_seats = sec.get("totalSeats") or 0
    seats_available = max(0, total_seats - (sec.get("registeredSeats") or 0))

    return {
        "section_id":      sec.get("sisSectionId", ""),
        "section_type":    sec.get("rnrMode", "Lecture"),
        "professor":       professor,
        "days":            schedule.get("days", []),
        "start_time":      schedule.get("startTime", ""),
        "end_time":        schedule.get("endTime", ""),
        "location":        "TBA",   # not available in the USC API
        "units":           units,
        "seats_available": seats_available,
        "total_seats":     total_seats,
        "modality":        MODALITY_MAP.get(sec.get("rnrMode", ""), "in_person"),
    }


def extract_sections(course: dict) -> list[dict]:
    """
    Parses raw course data from CoursesByTermSchoolProgram into structured section dicts.

    Linked-section logic:
    - Sections sharing the same linkCode form an enrollment group.
    - Within a group, "Lecture" (or Seminar/Activity) sections are primary.
    - "Discussion" / "Lab" / "Quiz" sections are secondary — the student must
      pick one secondary per group alongside the primary.
    - Sections with isCancelled=True or isFull=True are excluded.
    """
    raw_sections = course.get("sections") or []

    # Group open sections by linkCode
    link_groups: dict[str, list] = {}
    for sec in raw_sections:
        if sec.get("isCancelled") or sec.get("isFull"):
            continue
        link_code = sec.get("linkCode") or "NONE"
        link_groups.setdefault(link_code, []).append(sec)

    result = []
    for link_code, secs in link_groups.items():
        primaries   = [s for s in secs if s.get("rnrMode") in LECTURE_MODES]
        secondaries = [s for s in secs if s.get("rnrMode") not in LECTURE_MODES]

        # Standalone courses (no distinct lecture type): treat all as primary
        if not primaries:
            primaries   = secs
            secondaries = []

        for primary in primaries:
            section = _parse_section(primary)
            section["link_code"] = link_code
            section["ge_categories"] = []  # populated by ge_finder.py

            section["linked_sections"] = [
                _parse_section(s) for s in secondaries
            ]

            result.append(section)

    return result


# ── Department-level cache (per request) ─────────────────────────────────────
# Avoids re-fetching all 77 CSCI courses if the user entered both CSCI 270
# and CSCI 350 in the same request.
_dept_cache: dict[str, list] = {}


async def scrape_course(
    course_code: str,
    client: httpx.AsyncClient,
    school_lookup: dict[str, str],
) -> list[dict]:
    """
    Fetches all open sections for a given course code (e.g. "CSCI 270").
    Returns a list of primary-section dicts, each with a linked_sections list.
    """
    parts = course_code.strip().upper().split()
    if len(parts) < 2:
        return []
    dept, number = parts[0], parts[1]

    school = school_lookup.get(dept)
    if not school:
        return []

    cache_key = f"{school}:{dept}"
    if cache_key not in _dept_cache:
        r = await client.get(
            f"{BASE_URL}/Courses/CoursesByTermSchoolProgram",
            params={"termCode": TERM_CODE, "school": school, "program": dept},
        )
        r.raise_for_status()
        data = r.json()
        _dept_cache[cache_key] = data.get("courses") or []

    courses = _dept_cache[cache_key]
    course = next((c for c in courses if c.get("classNumber") == number), None)
    if not course:
        return []

    return extract_sections(course)


async def fetch_dept_courses(
    dept: str,
    school: str,
    client: httpx.AsyncClient,
) -> list:
    """
    Fetch all courses for a department, using the per-request cache.
    Ge_finder calls this to scan departments without double-fetching.
    """
    cache_key = f"{school}:{dept}"
    if cache_key not in _dept_cache:
        r = await client.get(
            f"{BASE_URL}/Courses/CoursesByTermSchoolProgram",
            params={"termCode": TERM_CODE, "school": school, "program": dept},
        )
        r.raise_for_status()
        _dept_cache[cache_key] = r.json().get("courses") or []
    return _dept_cache[cache_key]


def clear_dept_cache() -> None:
    """Call at the start of each /generate request to reset per-request cache."""
    _dept_cache.clear()

import asyncio
import os
import time
import httpx

# How long a fetched department catalog stays usable before we re-fetch it.
# Catalog structure is stable within a term; only seat counts drift, so a short
# TTL keeps repeat requests near-instant while staying fresh enough on seats.
DEPT_CACHE_TTL = float(os.getenv("DEPT_CACHE_TTL", "300"))  # seconds, default 5 min
BASE_URL = "https://classes.usc.edu/api"

HTTP_HEADERS = {
    "Accept": "application/json",
    "Referer": "https://classes.usc.edu/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

LECTURE_MODES = {"Lecture", "Seminar", "Activity", "Workshop", "Screening"}


def _is_primary_mode(rnr_mode: str) -> bool:
    """
    True for section modes that stand on their own as a primary section.

    Besides the plain lecture modes, USC has self-contained combined sections
    like "Lecture/Discussion" or "Lecture/Lab" (e.g. BUAD 307 section 14848):
    a single section that already bundles the lecture and its discussion, so the
    student does NOT also pick a separate Discussion/Lab. These arrive with no
    linkCode, so if they aren't recognized as primaries they get mistaken for
    orphan secondaries and attached to every real lecture — making the solver
    pick Lecture + Discussion + Lecture/Discussion all at once.
    """
    return rnr_mode in LECTURE_MODES or (rnr_mode or "").startswith("Lecture/")

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


async def build_school_lookup(client: httpx.AsyncClient, term_code: str) -> dict[str, str]:
    """
    Returns {dept_prefix: school_prefix}, e.g. {"CSCI": "ENGV", "MATH": "DORS"}.
    Department-to-school mapping is term-specific, so this is built and cached
    per term by the caller.
    """
    r = await client.get(f"{BASE_URL}/Programs/TermCode", params={"termCode": term_code})
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
    - Some courses (e.g. EE 141) split a single shared Discussion off into its
      own linkCode while the labs share the lecture's linkCode. Those orphan
      secondaries get attached to every primary lecture in the course so the
      solver doesn't mistake the orphan for a standalone lecture and pick it
      as a tiny phantom "EE 141" section.
    - Sections with isCancelled=True are excluded.
    """
    raw_sections = course.get("sections") or []

    # Group open sections by linkCode
    link_groups: dict[str, list] = {}
    for sec in raw_sections:
        if sec.get("isCancelled"):
            continue
        link_code = sec.get("linkCode") or "NONE"
        link_groups.setdefault(link_code, []).append(sec)

    # Split groups into "has a real lecture" vs "secondaries only" (orphans).
    primary_groups: list[tuple[str, list, list]] = []  # (link_code, primaries, own_secondaries)
    orphan_secondaries: list = []
    for link_code, secs in link_groups.items():
        primaries = [s for s in secs if _is_primary_mode(s.get("rnrMode"))]
        secondaries = [s for s in secs if not _is_primary_mode(s.get("rnrMode"))]
        if primaries:
            primary_groups.append((link_code, primaries, secondaries))
        else:
            orphan_secondaries.extend(secondaries)

    result = []

    if not primary_groups:
        # Course has no lecture-mode section anywhere — treat every remaining
        # section as a standalone primary (lecture-less seminars, etc.).
        for link_code, secs in link_groups.items():
            for primary in secs:
                section = _parse_section(primary)
                section["link_code"] = link_code
                section["ge_categories"] = []
                section["linked_sections"] = []
                result.append(section)
        return result

    # Normal case: each primary becomes a bundle with its own secondaries plus
    # any course-wide orphan secondaries.
    for link_code, primaries, own_secondaries in primary_groups:
        for primary in primaries:
            section = _parse_section(primary)
            section["link_code"] = link_code
            section["ge_categories"] = []  # populated by ge_finder.py
            section["linked_sections"] = [
                _parse_section(s) for s in (own_secondaries + orphan_secondaries)
            ]
            result.append(section)

    return result


# ── Department-level cache (cross-request, TTL-based) ────────────────────────
# Avoids re-fetching all 77 CSCI courses if the user entered both CSCI 270
# and CSCI 350 in the same request, and keeps catalogs warm across requests
# for DEPT_CACHE_TTL seconds (seat counts may be up to that stale).
# Keyed by "TERM:SCHOOL:DEPT" → (fetched_at_epoch, courses_list).
#
# The term MUST stay in this key. Terms share school and department prefixes,
# so a key of just "SCHOOL:DEPT" would hand a Fall catalog to a Spring request
# and vice versa — with no error and entirely plausible-looking sections.
_dept_cache: dict[str, tuple[float, list]] = {}


def _cache_key(term_code: str, school: str, dept: str) -> str:
    return f"{term_code}:{school}:{dept}"


# Cache keys with a background refresh currently in flight, so repeated misses
# for the same dept don't stampede USC with duplicate fetches.
_inflight_refreshes: set[str] = set()


async def _fetch_dept_from_usc(
    dept: str, school: str, client: httpx.AsyncClient, term_code: str
) -> list:
    r = await client.get(
        f"{BASE_URL}/Courses/CoursesByTermSchoolProgram",
        params={"termCode": term_code, "school": school, "program": dept},
    )
    r.raise_for_status()
    return r.json().get("courses") or []


async def _refresh_dept_bg(
    cache_key: str, dept: str, school: str, client: httpx.AsyncClient, term_code: str
) -> None:
    """Background dept refresh: warms the cache without blocking any request."""
    try:
        courses = await _fetch_dept_from_usc(dept, school, client, term_code)
        _dept_cache[cache_key] = (time.time(), courses)
    except Exception:
        pass
    finally:
        _inflight_refreshes.discard(cache_key)


def _schedule_refresh(
    cache_key: str, dept: str, school: str, client: httpx.AsyncClient, term_code: str
) -> None:
    if cache_key in _inflight_refreshes:
        return
    _inflight_refreshes.add(cache_key)
    try:
        asyncio.create_task(_refresh_dept_bg(cache_key, dept, school, client, term_code))
    except RuntimeError:
        # No running loop (e.g. a sync context); drop the reservation.
        _inflight_refreshes.discard(cache_key)


async def _get_dept_courses(
    dept: str,
    school: str,
    client: httpx.AsyncClient,
    term_code: str,
    block_on_miss: bool = True,
) -> list:
    """
    Return a department's catalog, treating the cache as an authoritative
    snapshot for the request path.

    - Fresh hit → return immediately.
    - Stale but present → return the stale copy immediately and refresh in the
      background (serve-stale-while-revalidate). A user never waits on a re-fetch
      of data we already have.
    - Cold (nothing cached):
        - block_on_miss=True  (warmer / preview): fetch synchronously and cache.
        - block_on_miss=False (request path): kick off a background fill and
          return [] for this response — the next request serves it warm. This is
          the snapshot trade: /generate never blocks on a cold USC fetch.
    """
    cache_key = _cache_key(term_code, school, dept)
    entry = _dept_cache.get(cache_key)
    now = time.time()

    if entry is not None and now - entry[0] < DEPT_CACHE_TTL:
        return entry[1]

    if entry is not None:
        _schedule_refresh(cache_key, dept, school, client, term_code)
        return entry[1]

    if not block_on_miss:
        _schedule_refresh(cache_key, dept, school, client, term_code)
        return []

    courses = await _fetch_dept_from_usc(dept, school, client, term_code)
    _dept_cache[cache_key] = (time.time(), courses)
    return courses


async def scrape_course(
    course_code: str,
    client: httpx.AsyncClient,
    school_lookup: dict[str, str],
    term_code: str,
    block_on_miss: bool = True,
) -> list[dict]:
    """
    Fetches all open sections for a given course code (e.g. "CSCI 270").
    Returns a list of primary-section dicts, each with a linked_sections list.

    block_on_miss=False (the /generate request path) serves from the cache
    snapshot and never blocks on a cold fetch — see _get_dept_courses.
    """
    parts = course_code.strip().upper().split()
    if len(parts) < 2:
        return []
    dept, number = parts[0], parts[1]

    school = school_lookup.get(dept)
    if not school:
        return []

    courses = await _get_dept_courses(dept, school, client, term_code, block_on_miss)
    course = next((c for c in courses if c.get("classNumber") == number), None)
    if not course:
        return []

    return extract_sections(course)


async def fetch_dept_courses(
    dept: str,
    school: str,
    client: httpx.AsyncClient,
    term_code: str,
    block_on_miss: bool = True,
) -> list:
    """
    Fetch all courses for a department, using the TTL cache.
    Ge_finder calls this to scan departments without double-fetching.

    Defaults to blocking so the background warmer fully populates the snapshot;
    the /generate request path passes block_on_miss=False.
    """
    return await _get_dept_courses(dept, school, client, term_code, block_on_miss)


def clear_dept_cache(term_code: str | None = None) -> None:
    """
    Drop cached department catalogs (tests / manual invalidation).
    Pass a term to invalidate just that term; omit it to drop everything.
    """
    if term_code is None:
        _dept_cache.clear()
        return
    prefix = f"{term_code}:"
    for key in [k for k in _dept_cache if k.startswith(prefix)]:
        del _dept_cache[key]


def lookup_section_in_cache(section_id: str, term_code: str) -> str | None:
    """
    Scan the dept cache for a sisSectionId within one term.
    Returns the course code (e.g. "CSCI 270") if found, None otherwise.
    Only works after departments have been fetched (e.g. during GE candidate scraping).

    Scoped to a term because section ids are only unique within one: an
    unscoped scan would resolve a section from whichever term happened to be
    cached, which is how a Spring schedule ends up citing a Fall section.
    """
    prefix = f"{term_code}:"
    for key, (_, courses) in _dept_cache.items():
        if not key.startswith(prefix):
            continue
        for course in courses:
            for sec in (course.get("sections") or []):
                if sec.get("sisSectionId") == section_id:
                    dept = course.get("prefix") or ""
                    number = course.get("classNumber") or ""
                    if dept and number:
                        return f"{dept} {number}"
    return None

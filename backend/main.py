import asyncio
import re
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
import os

from scraper import build_school_lookup, clear_dept_cache, HTTP_HEADERS

# --- Pydantic models ---

class CourseInput(BaseModel):
    type: str                           # "course" | "ge"
    code: str | None = None
    category: str | None = None
    categories: list[str] | None = None # multi-GE double-count hunting
    professor: str | None = None        # optional professor pin
    section_id: str | None = None       # optional exact section pin
    ge_code: str | None = None          # specific course within a GE category
    search_query: str | None = None     # raw single-field input (auto-parsed)

class Constraints(BaseModel):
    earliest_start: str
    latest_end: str
    days_off: list[str]
    max_units: int
    no_back_to_back: bool
    modality: str      # "in_person" | "online" | "no_preference"

class GenerateRequest(BaseModel):
    must_haves: list[CourseInput]
    nice_to_haves: list[CourseInput]
    constraints: Constraints
    prof_slider: float = 0.5
    convenience_slider: float = 0.5
    discussion_preferences: dict[str, str] | None = None          # legacy: course_code -> section_id
    linked_section_preferences: dict[str, dict[str, str]] | None = None  # course_code -> type -> section_id


# --- Smart query parser ---

_COURSE_CODE_RE = re.compile(r'^([A-Z]{2,5})\s*(\d{3}[A-Z]{0,2})\b', re.IGNORECASE)

def parse_course_query(query: str) -> dict:
    """
    Classify a raw search string into structured fields.
    Returns {"code": ..., "professor": ..., "section_id": ...} with None for unmatched fields.

    Rules:
      5 digits only             → section_id
      course code pattern       → code (+ optional professor from remainder)
      anything else             → professor name
    """
    q = query.strip()
    if not q:
        return {"code": None, "professor": None, "section_id": None}

    if re.fullmatch(r'\d{5}', q):
        return {"code": None, "professor": None, "section_id": q}

    m = _COURSE_CODE_RE.match(q.upper())
    if m:
        code = f"{m.group(1).upper()} {m.group(2).upper()}"
        remainder = q[m.end():].strip()
        return {"code": code, "professor": remainder or None, "section_id": None}

    return {"code": None, "professor": q, "section_id": None}


def _resolve_entry(entry: CourseInput) -> tuple[str | None, str | None, str | None]:
    """Return (code, professor, section_id), applying search_query parsing if set."""
    if entry.search_query and entry.type == "course":
        parsed = parse_course_query(entry.search_query)
        return (
            parsed["code"] or entry.code,
            parsed["professor"] or entry.professor,
            parsed["section_id"] or entry.section_id,
        )
    return entry.code, entry.professor, entry.section_id

# --- App state ---

http_client: httpx.AsyncClient | None = None
school_lookup: dict[str, str] = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, school_lookup
    http_client = httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True, timeout=30.0)
    school_lookup = await build_school_lookup(http_client)
    print(f"School lookup ready: {len(school_lookup)} departments")
    yield
    await http_client.aclose()

# --- App ---

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok", "departments_loaded": len(school_lookup)}

@app.get("/course-options")
async def course_options(code: str):
    """
    Returns the list of open lecture sections for a course code.
    Used by the frontend to populate professor and time slot dropdowns.
    Does not clear the dept cache — acts as a read-only preview.
    """
    from scraper import scrape_course
    raw = await scrape_course(code.strip().upper(), http_client, school_lookup)

    professors = sorted({
        s["professor"] for s in raw
        if s.get("professor") and s["professor"] != "TBA"
    })

    sections = sorted(
        [
            {
                "section_id": s["section_id"],
                "professor": s["professor"],
                "days": s["days"],
                "start_time": s["start_time"],
                "end_time": s["end_time"],
                "seats_available": s["seats_available"],
                "total_seats": s.get("total_seats", 0),
            }
            for s in raw
        ],
        key=lambda s: s["start_time"],
    )

    return {"professors": professors, "sections": sections}

@app.post("/generate")
async def generate(req: GenerateRequest):
    from scraper import scrape_course
    from solver import (
        Section, LinkedSection,
        Constraints as SolverConstraints,
        CourseInput as SolverCourseInput,
        build_schedules,
    )

    clear_dept_cache()

    # Merge legacy discussion_preferences into linked_section_preferences
    merged_linked_prefs: dict[str, dict[str, str]] = {}
    if req.linked_section_preferences:
        for code, prefs in req.linked_section_preferences.items():
            merged_linked_prefs[code] = dict(prefs)
    if req.discussion_preferences:
        for code, sid in req.discussion_preferences.items():
            merged_linked_prefs.setdefault(code, {})["discussion"] = sid

    # 1. Scrape sections for all course inputs in parallel (deduplicated by resolved code)
    codes = list({
        code
        for entry in req.must_haves + req.nice_to_haves
        if entry.type == "course"
        for code, _, _ in [_resolve_entry(entry)]
        if code
    })
    results = await asyncio.gather(*[
        scrape_course(code, http_client, school_lookup) for code in codes
    ])
    scraped: dict[str, list] = dict(zip(codes, results))

    # 2. Convert scraper dicts → solver Section dataclasses
    def _to_sections(course_code: str, raw: list) -> list[Section]:
        result = []
        for s in raw:
            linked = [
                LinkedSection(
                    section_id=ls["section_id"],
                    section_type=ls["section_type"],
                    days=ls["days"],
                    start_time=ls["start_time"],
                    end_time=ls["end_time"],
                    seats_available=ls["seats_available"],
                    total_seats=ls.get("total_seats", 0),
                    location=ls.get("location", "TBA"),
                )
                for ls in s.get("linked_sections", [])
            ]
            result.append(Section(
                course=course_code,
                section_id=s["section_id"],
                section_type=s["section_type"],
                professor=s["professor"],
                days=s["days"],
                start_time=s["start_time"],
                end_time=s["end_time"],
                location=s.get("location", "TBA"),
                units=s["units"],
                modality=s["modality"],
                seats_available=s["seats_available"],
                total_seats=s.get("total_seats", 0),
                ge_categories=s.get("ge_categories", []),
                linked_sections=linked,
            ))
        return result

    all_sections = {code: _to_sections(code, raw) for code, raw in scraped.items()}

    def _to_sections_with_ge(raw: list) -> list[Section]:
        """Convert ge_finder section dicts (which include course_code) to Section objects."""
        result = []
        for s in raw:
            result.extend(_to_sections(s["course_code"], [s]))
        return result

    # 3. Build solver inputs from request
    must_have_courses = []
    for e in req.must_haves:
        if e.type != "course":
            continue
        code, professor, section_id = _resolve_entry(e)
        must_have_courses.append(SolverCourseInput(
            input_type=e.type,
            code=code,
            professor=professor,
            section_id=section_id,
            preferred_linked_section_ids=merged_linked_prefs.get(code or "") or None,
        ))

    ge_inputs = [
        SolverCourseInput(
            input_type=e.type,
            category=e.category,
            categories=e.categories,
            professor=e.professor,
            section_id=e.section_id,
            ge_code=e.ge_code,
        )
        for e in req.must_haves + req.nice_to_haves if e.type == "ge"
    ]

    nice_to_haves = []
    for e in req.nice_to_haves:
        if e.type != "course":
            continue
        code, professor, section_id = _resolve_entry(e)
        nice_to_haves.append(SolverCourseInput(
            input_type=e.type,
            code=code,
            professor=professor,
            section_id=section_id,
        ))
    solver_constraints = SolverConstraints(
        earliest_start=req.constraints.earliest_start,
        latest_end=req.constraints.latest_end,
        days_off=req.constraints.days_off,
        max_units=req.constraints.max_units,
        no_back_to_back=req.constraints.no_back_to_back,
        modality=req.constraints.modality,
    )

    # 4. Fetch GE candidate sections
    from ge_finder import build_ge_candidates
    requested_categories: list[str] = []
    for e in req.must_haves + req.nice_to_haves:
        if e.type == "ge":
            if e.category:
                requested_categories.append(e.category)
            if e.categories:
                requested_categories.extend(e.categories)
    requested_categories = list(set(requested_categories))
    raw_ge = await build_ge_candidates(requested_categories, school_lookup, http_client)

    ge_candidates = {
        slot: _to_sections_with_ge(sections)
        for slot, sections in raw_ge.items()
    }

    # 4b. Resolve section_id-only entries via the now-populated dept cache
    from scraper import lookup_section_in_cache
    unresolved_ids = [
        (entry, sid)
        for entry in req.must_haves + req.nice_to_haves
        if entry.type == "course"
        for code, _, sid in [_resolve_entry(entry)]
        if sid and not code
    ]
    if unresolved_ids:
        late_codes: set[str] = set()
        for _, sid in unresolved_ids:
            found_code = lookup_section_in_cache(sid)
            if found_code:
                late_codes.add(found_code)
        if late_codes:
            late_results = await asyncio.gather(*[
                scrape_course(c, http_client, school_lookup) for c in late_codes
            ])
            for c, raw in zip(late_codes, late_results):
                if c not in all_sections:
                    all_sections[c] = _to_sections(c, raw)

    # 5. Enrich all sections with RMP data
    from rmp import enrich_with_rmp
    combined = dict(all_sections)
    combined.update({slot: secs for slot, secs in ge_candidates.items()})
    await enrich_with_rmp(combined, http_client)

    # 6. Run solver
    result = build_schedules(
        must_have_inputs=must_have_courses,
        ge_inputs=ge_inputs,
        nice_to_have_inputs=nice_to_haves,
        all_sections=all_sections,
        ge_candidates=ge_candidates,
        constraints=solver_constraints,
        prof_slider=req.prof_slider,
        convenience_slider=req.convenience_slider,
    )

    # 7. Render schedule images
    schedules = result.get("schedules", [])
    if schedules:
        from image_gen import generate_schedule_images
        images = await generate_schedule_images(schedules)
        for schedule, img in zip(schedules, images):
            schedule["image_base64"] = img

    return result

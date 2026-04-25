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
    discussion_preferences: dict[str, str] | None = None  # course_code -> "morning"|"afternoon"|"evening"

# --- App state ---

http_client: httpx.AsyncClient | None = None
school_lookup: dict[str, str] = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, school_lookup
    http_client = httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True)
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

    # 1. Scrape sections for all course inputs (deduplicated by code)
    scraped: dict[str, list] = {}
    for entry in req.must_haves + req.nice_to_haves:
        if entry.type == "course" and entry.code and entry.code not in scraped:
            scraped[entry.code] = await scrape_course(entry.code, http_client, school_lookup)

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
    disc_prefs = req.discussion_preferences or {}

    must_have_courses = [
        SolverCourseInput(
            input_type=e.type,
            code=e.code,
            professor=e.professor,
            section_id=e.section_id,
            preferred_discussion_time=disc_prefs.get(e.code) if e.code else None,
        )
        for e in req.must_haves if e.type == "course"
    ]
    ge_inputs = [
        SolverCourseInput(
            input_type=e.type,
            category=e.category,
            categories=e.categories,
        )
        for e in req.must_haves + req.nice_to_haves if e.type == "ge"
    ]
    nice_to_haves = [
        SolverCourseInput(
            input_type=e.type,
            code=e.code,
            professor=e.professor,
            section_id=e.section_id,
        )
        for e in req.nice_to_haves if e.type == "course"
    ]
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

    # 5. Enrich all sections with RMP data
    from rmp import enrich_with_rmp
    combined = dict(all_sections)
    combined.update({slot: secs for slot, secs in ge_candidates.items()})
    await enrich_with_rmp(combined, http_client)

    # 6. Run solver
    return build_schedules(
        must_have_inputs=must_have_courses,
        ge_inputs=ge_inputs,
        nice_to_have_inputs=nice_to_haves,
        all_sections=all_sections,
        ge_candidates=ge_candidates,
        constraints=solver_constraints,
        prof_slider=req.prof_slider,
        convenience_slider=req.convenience_slider,
    )

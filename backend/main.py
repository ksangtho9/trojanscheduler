import asyncio
import re
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
import os
from dotenv import load_dotenv

load_dotenv()

# When set, /generate logs a per-phase timing breakdown to stdout and attaches
# a `_timing` block to the response. Off by default so the response contract is
# unchanged. Enable with TROJAN_DEBUG_TIMING=1 (used by bench_generate.py).
DEBUG_TIMING = os.getenv("TROJAN_DEBUG_TIMING", "").lower() in ("1", "true", "yes")

from scraper import build_school_lookup, HTTP_HEADERS

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
    planning_mode: bool = False
    # Which USC term to schedule against. Omitted means "the default active
    # term", which keeps older clients working unchanged.
    term_code: str | None = None
    # course_code → {"lecture_section_id": ..., "discussion": ..., "lab": ..., "quiz": ...}
    linked_section_preferences: dict[str, dict[str, str]] | None = None


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

# Department→school mapping is term-specific, so it is held per term rather
# than as one startup dict. Built lazily on first use of a term: warming all
# active terms eagerly would triple cold-start latency for terms nobody asked
# for. Keyed by term code.
_school_lookups: dict[str, dict[str, str]] = {}
_school_lookup_locks: dict[str, asyncio.Lock] = {}
_ge_warmer_task: asyncio.Task | None = None


async def get_school_lookup(term_code: str) -> dict[str, str]:
    """
    The department→school map for one term, built once and reused.

    Guarded by a per-term lock so concurrent first requests for the same term
    don't each pay for the (slow) lookup build.
    """
    cached = _school_lookups.get(term_code)
    if cached:
        return cached

    lock = _school_lookup_locks.setdefault(term_code, asyncio.Lock())
    async with lock:
        cached = _school_lookups.get(term_code)
        if cached:
            return cached
        lookup = await build_school_lookup(http_client, term_code)
        _school_lookups[term_code] = lookup
        print(f"School lookup ready for {term_code}: {len(lookup)} departments")
        return lookup


async def _ge_warmer_loop():
    """
    Keep GE department catalogs warm in the dept cache. Re-warms on the cache
    TTL cadence so /generate requests with GE slots rarely hit cold fetches.
    fetch_dept_courses is a no-op for entries still within TTL, so each cycle
    only re-fetches catalogs that have actually expired.

    Warms the default term first, then the other active terms: a request for
    the term most students want should not queue behind warming for terms
    nobody has asked for. A failure on one term never aborts the others.
    """
    from scraper import DEPT_CACHE_TTL
    from ge_finder import warm_ge_departments
    from terms import fetch_active_terms, default_term
    while True:
        try:
            active = await fetch_active_terms(http_client)
            ordered = sorted(
                active,
                key=lambda t: t["term_code"] != default_term(active),
            )
        except Exception as e:
            print(f"Term list unavailable, skipping GE warm-up cycle: {e}")
            await asyncio.sleep(DEPT_CACHE_TTL)
            continue

        for term in ordered:
            code = term["term_code"]
            try:
                lookup = await get_school_lookup(code)
                n = await warm_ge_departments(lookup, http_client, code)
                print(f"GE warm-up complete for {term['label']}: {n} departments cached")
            except Exception as e:
                print(f"GE warm-up failed for {term['label']} (will retry): {e}")
        await asyncio.sleep(DEPT_CACHE_TTL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, _ge_warmer_task
    # Generous read timeout: some USC department endpoints are very slow
    # (e.g. DSO's CoursesByTermSchoolProgram takes ~110s). A short timeout makes
    # those courses unusable in /generate and silently shrinks GE candidate pools.
    http_client = httpx.AsyncClient(
        headers=HTTP_HEADERS,
        follow_redirects=True,
        timeout=httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=120.0),
    )
    _ge_warmer_task = asyncio.create_task(_ge_warmer_loop())
    yield
    _ge_warmer_task.cancel()
    await http_client.aclose()

# --- App ---

app = FastAPI(lifespan=lifespan)

_raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

async def _resolve_term_or_400(term_code) -> str:
    """
    Validate a caller-supplied term, or fall back to the default active one.

    An unrecognized term is a 400 rather than an empty result set: scraping a
    dead term returns no sections, which would surface to the student as "no
    schedules found" and read as "your constraints are too tight".
    """
    from terms import resolve_term, TermUnavailableError
    try:
        return await resolve_term(term_code, http_client)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except TermUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/health")
def health():
    return {
        "status": "ok",
        "terms_loaded": sorted(_school_lookups),
        "departments_loaded": {t: len(l) for t, l in _school_lookups.items()},
    }

@app.get("/terms")
async def terms():
    """
    The terms USC currently has open for registration, newest first, plus which
    one the app defaults to. The frontend renders this directly, so the ordering
    and default rule live here rather than being duplicated client-side.
    """
    from terms import fetch_active_terms, default_term
    active = await fetch_active_terms(http_client)
    return {"terms": active, "default": default_term(active)}

@app.get("/course-options")
async def course_options(code: str, term: str | None = None):
    """
    Returns the list of open lecture sections for a course code.
    Used by the frontend to populate professor and time slot dropdowns.
    Does not clear the dept cache — acts as a read-only preview.
    """
    from scraper import scrape_course
    term_code = await _resolve_term_or_400(term)
    school_lookup = await get_school_lookup(term_code)
    raw = await scrape_course(code.strip().upper(), http_client, school_lookup, term_code)

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

    # Resolve and validate the term before any scraping: an invalid term must
    # fail loudly here rather than quietly producing an empty catalog.
    term_code = await _resolve_term_or_400(req.term_code)
    school_lookup = await get_school_lookup(term_code)

    linked_prefs: dict[str, dict[str, str]] = {
        code: dict(prefs) for code, prefs in (req.linked_section_preferences or {}).items()
    }

    # Per-phase timing (see DEBUG_TIMING). _clock is monotonic; each phase records
    # its own wall-clock so the breakdown sums to ~total. Cheap; always collected.
    _clock = time.perf_counter
    _timing: dict[str, float] = {}
    _req_start = _clock()

    # 1. Scrape sections for all course inputs in parallel (deduplicated by resolved code)
    _t0 = _clock()
    codes = list({
        code
        for entry in req.must_haves + req.nice_to_haves
        if entry.type == "course"
        for code, _, _ in [_resolve_entry(entry)]
        if code
    })
    results = await asyncio.gather(*[
        scrape_course(code, http_client, school_lookup, term_code) for code in codes
    ])
    scraped: dict[str, list] = dict(zip(codes, results))
    _timing["scrape_ms"] = round((_clock() - _t0) * 1000, 1)

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
            preferred_linked_section_ids=linked_prefs.get(code or ""),
        ))

    # GE entries from req.must_haves are required; ones from req.nice_to_haves
    # are best-effort — the solver should silently skip them when no candidate
    # fits, instead of dropping the whole must-have combination.
    ge_inputs = []
    for e in req.must_haves:
        if e.type == "ge":
            ge_inputs.append(SolverCourseInput(
                input_type=e.type,
                category=e.category,
                categories=e.categories,
                professor=e.professor,
                section_id=e.section_id,
                ge_code=e.ge_code,
                is_optional=False,
            ))
    for e in req.nice_to_haves:
        if e.type == "ge":
            ge_inputs.append(SolverCourseInput(
                input_type=e.type,
                category=e.category,
                categories=e.categories,
                professor=e.professor,
                section_id=e.section_id,
                ge_code=e.ge_code,
                is_optional=True,
            ))

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
    _t0 = _clock()
    from ge_finder import build_ge_candidates
    requested_categories: list[str] = []
    for e in req.must_haves + req.nice_to_haves:
        if e.type == "ge":
            if e.category:
                requested_categories.append(e.category)
            if e.categories:
                requested_categories.extend(e.categories)
    requested_categories = list(set(requested_categories))
    raw_ge = await build_ge_candidates(
        requested_categories, school_lookup, http_client, term_code
    )

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
            found_code = lookup_section_in_cache(sid, term_code)
            if found_code:
                late_codes.add(found_code)
        if late_codes:
            late_results = await asyncio.gather(*[
                scrape_course(c, http_client, school_lookup, term_code) for c in late_codes
            ])
            for c, raw in zip(late_codes, late_results):
                if c not in all_sections:
                    all_sections[c] = _to_sections(c, raw)

    # 4c. Pre-filter the GE candidate pool by the lecture-level hard constraints
    # *before* RMP enrichment. GE pools span hundreds of professors, most of
    # whose sections the solver later drops on seats/modality/time/days. Pruning
    # them here shrinks the unique-professor set we hit RMP for. This is
    # output-preserving: the solver re-applies these exact lecture-level filters
    # in filter_and_pin_sections, so we only remove sections it would also drop.
    # Skipped in planning_mode, where the solver bypasses these filters entirely.
    if not req.planning_mode:
        from solver import (
            _section_in_time_window,
            _modality_ok,
            _no_day_off_conflict,
        )

        def _passes_hard_filters(s: Section) -> bool:
            return (
                s.seats_available > 0
                and _modality_ok(s, solver_constraints)
                and _section_in_time_window(s, solver_constraints)
                and _no_day_off_conflict(s.days, solver_constraints)
            )

        ge_candidates = {
            slot: [s for s in secs if _passes_hard_filters(s)]
            for slot, secs in ge_candidates.items()
        }
    _timing["ge_build_ms"] = round((_clock() - _t0) * 1000, 1)

    # 5. Enrich all sections with RMP data
    _t0 = _clock()
    from rmp import enrich_with_rmp
    combined = dict(all_sections)
    combined.update({slot: secs for slot, secs in ge_candidates.items()})
    await enrich_with_rmp(combined, http_client)
    _timing["rmp_ms"] = round((_clock() - _t0) * 1000, 1)

    # 6. Run solver
    _t0 = _clock()
    result = build_schedules(
        must_have_inputs=must_have_courses,
        ge_inputs=ge_inputs,
        nice_to_have_inputs=nice_to_haves,
        all_sections=all_sections,
        ge_candidates=ge_candidates,
        constraints=solver_constraints,
        prof_slider=req.prof_slider,
        convenience_slider=req.convenience_slider,
        planning_mode=req.planning_mode,
    )
    _timing["solve_ms"] = round((_clock() - _t0) * 1000, 1)
    _timing["total_ms"] = round((_clock() - _req_start) * 1000, 1)

    print("generate timing: " + " ".join(f"{k}={v}" for k, v in _timing.items()))
    if DEBUG_TIMING and isinstance(result, dict):
        result = {**result, "_timing": _timing}

    # Echo the term actually used so the frontend labels results with the
    # resolved term rather than the one it believes it asked for.
    if isinstance(result, dict):
        from terms import term_label
        result = {**result, "term_code": term_code, "term_label": term_label(term_code)}

    return result

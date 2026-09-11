# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

USC course schedule optimizer. The user enters must-have courses, optional GE slots and hard
constraints; the backend scrapes live section data from `classes.usc.edu`, enriches it with
RateMyProfessors ratings, and a backtracking solver returns the top 3 ranked non-conflicting
schedules. Live at https://trojanscheduler.vercel.app/

- **Frontend** — Next.js 16 + React 19 + TypeScript + Tailwind v4, deployed on Vercel
- **Backend** — FastAPI + Python 3.11, deployed on Railway via `backend/Dockerfile`

## Commands

```bash
# Backend (port 8000)
cd backend
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
curl http://localhost:8000/health

# Backend tests — plain scripts, not pytest. Exit non-zero on failure.
python3 test_solver.py             # planning_mode contract tests
python3 test_terms.py              # active-term registry
python3 test_scraper.py            # term-scoped scraping + cache isolation
python3 test_scraper.py --live     # smoke check against the real USC API
python3 test_ge_finder.py          # term-scoped GE discovery
python3 test_main_terms.py         # API-level term selection + validation

# Frontend (port 3000)
cd frontend
npm install
npm run dev
npm run build
npm run lint
```

There is no test runner config — `test_solver.py` and `test_scraper.py` are standalone `python3`
scripts with their own assertions. To run a single case, comment out the others in the test list at
the bottom of the file.

Regenerating the static course lists in `frontend/public/` (slow, sequential by design — the USC API
silently truncates under concurrency). These are per-term files named
`courses.<termCode>.json`; with no `--term` the generators loop over every active term:

```bash
cd backend
python generate_course_list.py                # --force to overwrite when a total shrinks
python generate_course_list.py --term 20261   # one term only
python generate_ge_course_list.py
```

`.github/workflows/refresh-course-lists.yml` runs these weekly and opens a PR when the data
changes, so a term rollover needs no source edit.

## Environment

`backend/.env` (copy from `.env.example`):
- `ALLOWED_ORIGINS` — comma-separated CORS origins, no trailing slashes

There is no longer a `TERM_CODE` to maintain. Terms are resolved at runtime from USC's
`/api/Terms/All`, filtered to `status == "Active"` — see Terms below.

Frontend reads `NEXT_PUBLIC_BACKEND_URL`, falling back to `http://localhost:8000`.

## Architecture

### Terms

`backend/terms.py` is the single source of truth for which semesters exist. USC's `/api/Terms/All`
returns 80+ terms; exactly the registerable ones carry `status: "Active"` (currently three at once).
Term codes are `YYYY` + a season digit (`1`=Spring, `2`=Summer, `3`=Fall), so `20263` is Fall 2026.

- The term is a **per-request parameter**, never a module constant. `/generate` takes an optional
  `term_code`; omitting it uses the newest active term. An inactive term is a 400 naming the valid
  terms — returning empty results instead would read to a student as "your constraints are too tight".
- **The term is part of every cache key.** `_dept_cache` is keyed `TERM:SCHOOL:DEPT` and
  `lookup_section_in_cache` takes a term. Dropping the term from either silently serves one term's
  catalog for another, with plausible-looking sections and no error. `test_scraper.py` has tests
  that exist purely to fail if this happens — do not weaken them.
- `school_lookup` is per-term, built lazily under a per-term lock. The GE warmer covers every active
  term, default first.
- `CATEGORY_PREFIX_MAP` in `ge_finder.py` is hardcoded rather than fetched: `/api/Ge/TermCode` is
  byte-identical across active terms once the echoed `termCode` is removed (verified 2026-09-11).

### Request flow

`POST /generate` in `backend/main.py` orchestrates everything:

0. Resolve and validate the term (`_resolve_term_or_400`) before any scraping
1. Resolve each `CourseInput` entry (free-text query → course code / professor / section pin) via
   `parse_course_query` and `_resolve_entry`
2. `scraper.scrape_course` fetches sections for all distinct course codes in parallel
3. Scraper dicts are converted to `solver.Section` dataclasses (`_to_sections`)
4. `ge_finder.build_ge_candidates` builds candidate pools for GE slots
5. `rmp.enrich_with_rmp` attaches RateMyProfessors data
6. `solver.build_schedules` runs the solve and returns serialized schedules

### Solver (`backend/solver.py`, ~1600 lines — the core of the project)

Pipeline inside `build_schedules`:

```
ScoringWeights.from_sliders  →  resolve_must_haves (backtracking, MRV)
                             →  for each combination: auto_select_ge
                                                      inject_nice_to_haves
                                                      score_schedule
                             →  _deduplicate → _diversity_aware_top_n
```

Key invariants:

- **`filter_and_pin_sections` and `expand_to_pairs` are the two chokepoints** where constraints are
  applied. Any new constraint has to be threaded through both, plus `_diagnose_over_constrained`
  (which produces the "no schedules found" explanation), and every caller: `resolve_must_haves`,
  `auto_select_ge`, `inject_nice_to_haves`.
- **Filtering and scoring are deliberately separate.** `planning_mode` bypasses the seat *filter*
  so full sections are eligible, but `_score_seats` is unchanged, so open sections still rank
  higher. Follow this pattern for anything similar — relax the filter, keep the score.
- A `SectionPair` is a primary section plus its chosen linked sections (discussion / lab / quiz).
  Conflict checks operate on pairs, not sections.
- When a course's linked sections can't be auto-resolved, the solver returns
  `needs_linked_section_prompt` + `prompt_type` instead of schedules; the frontend prompts and
  resubmits with `linked_section_preferences`. Types are surfaced one at a time in
  `LINKED_PROMPT_PRIORITY` order, and a type with only one option is never prompted.

### Scraper (`backend/scraper.py`)

`_is_primary_mode` is subtle: USC ships combined sections like `"Lecture/Discussion"` with no
`linkCode`. If they aren't treated as primaries they get mistaken for orphan secondaries and
attached to every real lecture. Department catalogs are cached in-process for `DEPT_CACHE_TTL`
(5 min default) — structure is stable within a term, only seat counts drift.

### Caching / warm-up

- `main.py` runs a background `_ge_warmer_loop` on the app lifespan that re-warms GE department
  catalogs on the cache TTL cadence, so `/generate` with GE slots rarely hits a cold fetch.
- HTTP client uses a 120s read timeout — some USC department endpoints genuinely take ~110s.
  Do not shorten this; it silently shrinks GE candidate pools.
- RMP results are cached to disk at `backend/.rmp_cache.json` (gitignored), 12h TTL.

### Frontend

`app/page.tsx` is a single client component holding the whole state machine
(`AppStage = "form" | "loading" | "results" | "detail"`) and the `callGenerate` fetch loop, which
recurses when the backend asks for a linked-section choice. Everything else is presentational.

`lib/types.ts` mirrors the `/generate` contract exactly — **change it in lockstep with
`solver.py`'s serializers** (`_serialize_pair`, `_serialize_linked`, `_serialize_runner_ups`) and
`main.py`'s Pydantic models. It is the only place the contract is documented.

`LoadingScreen` is held for `MIN_LOADING_MS` (4s) even when the backend is faster.

The frontend has its own `frontend/CLAUDE.md` → `frontend/AGENTS.md`, which warns that this Next.js
version has breaking changes vs. training data; read `node_modules/next/dist/docs/` before writing
Next-specific code.

## Known state

- `InputForm.tsx` is 2300+ lines and holds the course entry UI, constraints, and Planning Mode
  toggle. It has no client-side validation — empty submissions reach the backend.
- `README.md` mentions `backend/image_gen.py` and a Playwright-rendered schedule image; that file
  does not exist. The grid is rendered client-side by `ScheduleGrid.tsx`.
- `HANDOFF.md` is a point-in-time session log from the Planning Mode work, not maintained docs.
- `backend/.env` is tracked in git. It currently holds only `ALLOWED_ORIGINS`, but no secret should
  be added to it as-is.

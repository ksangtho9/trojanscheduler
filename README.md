# Trojan Scheduler

USC course schedule optimizer. Add your courses, set your constraints, and get ranked schedule options with professor ratings built in.

https://trojanscheduler.vercel.app/

## Features

- Search any USC course by code or name, including GE requirements
- Pin specific professors or sections, or let the solver pick the best
- Set hard constraints: time window, days off, modality (in-person / online), max units
- No back-to-back class toggle
- Schedules ranked by a combination of RateMyProfessors score and scheduling convenience
- Planning mode — ignores seat availability so you can plan ahead before registration opens
- Visual schedule grid with exportable image

## How it works

1. You add must-have courses and optional GE slots
2. The backend scrapes live section data from `classes.usc.edu` for the current term
3. Sections are enriched with RateMyProfessors ratings
4. A backtracking solver with MRV heuristic finds all valid non-conflicting combinations
5. Schedules are scored and the top 3 are returned with a rendered grid image

## Stack

- **Frontend:** Next.js + TypeScript + Tailwind CSS — deployed on Vercel
- **Backend:** FastAPI + Python 3.11 — deployed on Railway via Docker
- **Solver:** Custom backtracking solver (`backend/solver.py`)
- **Data:** USC `classes.usc.edu` API + RateMyProfessors GraphQL

## Project structure

```
backend/
  main.py              # FastAPI app + /generate endpoint
  scraper.py           # USC API section fetcher
  solver.py            # Backtracking schedule solver
  rmp.py               # RateMyProfessors enrichment
  image_gen.py         # Schedule grid image renderer (Playwright)
  generate_course_list.py
  generate_ge_course_list.py

frontend/
  app/page.tsx         # Main page + state machine
  components/
    InputForm.tsx      # Course entry + constraints UI
    LeftPanel.tsx      # Nav + branding
    ScheduleGrid.tsx   # Visual schedule grid
    ScheduleDetail.tsx # Schedule detail + section info
    LoadingScreen.tsx  # Generation progress screen
  public/
    courses.json       # Static course list
    ge_courses.json    # Static GE course list
```

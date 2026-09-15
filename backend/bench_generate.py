"""
bench_generate.py — repeatable timing harness for POST /generate.

Fires a representative payload (default: 4 must-have courses + 1 GE slot) at a
locally running backend and prints the per-phase breakdown so speed sacrifices
are chosen against real numbers instead of guesses.

Usage:
    # 1. Start the backend with timing enabled:
    #    TROJAN_DEBUG_TIMING=1 uvicorn main:app --host 0.0.0.0 --port 8000
    # 2. Run the harness:
    python bench_generate.py                       # warm + repeat
    python bench_generate.py --courses "CSCI 270,CSCI 201,MATH 225,WRIT 150" --ge D
    python bench_generate.py --url http://localhost:8000 --runs 3

The server prints its own `generate timing: ...` line; this harness also reads
the `_timing` block from the response (present when TROJAN_DEBUG_TIMING=1) and
adds a client-measured wall-clock for comparison.
"""

import argparse
import time

import httpx


def build_payload(courses: list[str], ge: str | None, planning: bool) -> dict:
    must_haves = [{"type": "course", "code": c} for c in courses]
    if ge:
        must_haves.append({"type": "ge", "category": ge})
    return {
        "must_haves": must_haves,
        "nice_to_haves": [],
        "constraints": {
            "earliest_start": "08:00",
            "latest_end": "20:00",
            "days_off": [],
            "max_units": 20,
            "no_back_to_back": False,
            "modality": "no_preference",
        },
        "prof_slider": 0.5,
        "convenience_slider": 0.5,
        "planning_mode": planning,
    }


def run_once(url: str, payload: dict) -> tuple[float, dict | None]:
    start = time.perf_counter()
    r = httpx.post(f"{url}/generate", json=payload, timeout=300.0)
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    r.raise_for_status()
    body = r.json()
    timing = body.get("_timing") if isinstance(body, dict) else None
    return elapsed_ms, timing


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument(
        "--courses",
        default="CSCI 270,CSCI 201,MATH 225,WRIT 150",
        help="comma-separated course codes",
    )
    ap.add_argument("--ge", default="D", help="single GE category letter (or empty for none)")
    ap.add_argument("--runs", type=int, default=2, help="number of sequential runs")
    ap.add_argument("--planning", action="store_true")
    args = ap.parse_args()

    courses = [c.strip() for c in args.courses.split(",") if c.strip()]
    ge = args.ge.strip() or None
    payload = build_payload(courses, ge, args.planning)

    print(f"POST {args.url}/generate  courses={courses}  ge={ge}  planning={args.planning}")
    print("-" * 72)
    for i in range(1, args.runs + 1):
        client_ms, timing = run_once(args.url, payload)
        label = "run 1 (cold-ish)" if i == 1 else f"run {i} (warm)"
        if timing:
            phases = "  ".join(f"{k}={v}" for k, v in timing.items())
            print(f"{label:18s} client={client_ms}ms  |  {phases}")
        else:
            print(
                f"{label:18s} client={client_ms}ms  "
                "(no _timing — start server with TROJAN_DEBUG_TIMING=1)"
            )


if __name__ == "__main__":
    main()

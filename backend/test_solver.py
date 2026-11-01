"""
test_solver.py — Goal-driven tests for the planning_mode feature.

Run: python3 test_solver.py
Exits non-zero on any failure.

These tests cover the contract: planning_mode must let the solver return
schedules even when the user's *soft preferences* (time window, days off,
modality, no-back-to-back) would otherwise eliminate every candidate. It
must still honor *explicit choices* (section_id pin).
"""
from __future__ import annotations
import sys
import traceback

from solver import (
    Section,
    LinkedSection,
    CourseInput,
    Constraints,
    build_schedules,
    expand_to_pairs,
    resolve_must_haves,
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def make_section(
    course: str,
    section_id: str,
    days: list[str],
    start_time: str,
    end_time: str,
    *,
    professor: str = "Prof Smith",
    modality: str = "in_person",
    rmp_score: float = 3.5,
    seats_available: int = 10,
    total_seats: int = 30,
    units: float = 4.0,
    linked_sections: list[LinkedSection] | None = None,
) -> Section:
    return Section(
        course=course,
        section_id=section_id,
        section_type="lecture",
        professor=professor,
        days=days,
        start_time=start_time,
        end_time=end_time,
        location="TBA",
        units=units,
        modality=modality,
        seats_available=seats_available,
        total_seats=total_seats,
        ge_categories=[],
        rmp_score=rmp_score,
        linked_sections=linked_sections or [],
    )


def base_constraints(
    *,
    earliest_start: str = "10:00",
    latest_end: str = "17:00",
    days_off: list[str] | None = None,
    max_units: int = 20,
    no_back_to_back: bool = False,
    modality: str = "no_preference",
) -> Constraints:
    return Constraints(
        earliest_start=earliest_start,
        latest_end=latest_end,
        days_off=days_off or [],
        max_units=max_units,
        no_back_to_back=no_back_to_back,
        modality=modality,
    )


def call_solver(sections_by_course, constraints, *, planning_mode: bool):
    must_haves = [
        CourseInput(input_type="course", code=code)
        for code in sections_by_course
    ]
    return build_schedules(
        must_have_inputs=must_haves,
        ge_inputs=[],
        nice_to_have_inputs=[],
        all_sections=sections_by_course,
        ge_candidates={},
        constraints=constraints,
        planning_mode=planning_mode,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_planning_mode_returns_schedules_despite_tight_time_window():
    # Only an early-morning section exists; user's window is 10:00–17:00.
    sections = {
        "CSCI 270": [make_section("CSCI 270", "20001", ["Mon", "Wed"], "07:00", "08:30")],
    }
    cons = base_constraints(earliest_start="10:00", latest_end="17:00")

    strict = call_solver(sections, cons, planning_mode=False)
    planning = call_solver(sections, cons, planning_mode=True)

    assert strict["error"] is not None, "strict mode should error on out-of-window sections"
    assert not strict["schedules"], "strict mode should produce no schedules"

    assert planning["error"] is None, f"planning mode should not error; got: {planning['error']!r}"
    assert len(planning["schedules"]) >= 1, "planning mode should return at least one schedule"


def test_planning_mode_returns_schedules_despite_days_off():
    # Section meets MWF; user marks all three as days off.
    sections = {
        "MATH 225": [make_section("MATH 225", "30001", ["Mon", "Wed", "Fri"], "11:00", "12:00")],
    }
    cons = base_constraints(days_off=["Mon", "Wed", "Fri"])

    strict = call_solver(sections, cons, planning_mode=False)
    planning = call_solver(sections, cons, planning_mode=True)

    assert strict["error"] is not None
    assert planning["error"] is None, f"planning mode should not error; got: {planning['error']!r}"
    assert len(planning["schedules"]) >= 1


def test_planning_mode_returns_schedules_despite_modality_mismatch():
    # Section is in_person; user requests online only.
    sections = {
        "WRIT 340": [make_section(
            "WRIT 340", "40001", ["Tue", "Thu"], "11:00", "12:20",
            modality="in_person",
        )],
    }
    cons = base_constraints(modality="online")

    strict = call_solver(sections, cons, planning_mode=False)
    planning = call_solver(sections, cons, planning_mode=True)

    assert strict["error"] is not None
    assert planning["error"] is None, f"planning mode should not error; got: {planning['error']!r}"
    assert len(planning["schedules"]) >= 1


def test_planning_mode_still_honors_section_id_pin():
    # User pinned a section_id that does not exist. planning_mode must NOT
    # silently swap to another section — the pin is explicit, not a soft pref.
    sections = {
        "CSCI 270": [make_section("CSCI 270", "20001", ["Mon", "Wed"], "11:00", "12:00")],
    }
    cons = base_constraints()

    must_haves = [CourseInput(input_type="course", code="CSCI 270", section_id="99999")]
    result = build_schedules(
        must_have_inputs=must_haves,
        ge_inputs=[],
        nice_to_have_inputs=[],
        all_sections=sections,
        ge_candidates={},
        constraints=cons,
        planning_mode=True,
    )
    assert result["error"] is not None, "pin to nonexistent section must still error in planning_mode"
    assert not result["schedules"]


def test_planning_mode_relaxes_no_back_to_back():
    # Two courses scheduled back-to-back (no gap). With no_back_to_back=True
    # they'd be rejected (10-min buffer required). planning_mode must bypass.
    sections = {
        "AAA 100": [make_section("AAA 100", "10001", ["Mon"], "10:00", "10:50")],
        "BBB 100": [make_section("BBB 100", "10002", ["Mon"], "10:50", "11:40")],
    }
    cons = base_constraints(no_back_to_back=True, max_units=20)

    strict = call_solver(sections, cons, planning_mode=False)
    planning = call_solver(sections, cons, planning_mode=True)

    # Strict: back-to-back enforced → no valid 2-course schedule.
    assert not strict["schedules"], "no_back_to_back should reject this combo when strict"
    # Planning: buffer relaxed → both courses fit.
    assert planning["error"] is None, f"planning mode should not error; got: {planning['error']!r}"
    assert len(planning["schedules"]) >= 1
    assert len(planning["schedules"][0]["courses"]) == 2


def test_strict_mode_still_works_for_happy_path():
    # Regression guard: nothing the planning_mode change does should break
    # the normal case. A clean schedule that satisfies all constraints must
    # still produce results in strict mode.
    sections = {
        "CSCI 270": [make_section("CSCI 270", "20001", ["Mon", "Wed"], "11:00", "12:00")],
        "MATH 225": [make_section("MATH 225", "30001", ["Tue", "Thu"], "13:00", "14:20")],
    }
    cons = base_constraints()

    result = call_solver(sections, cons, planning_mode=False)
    assert result["error"] is None, f"happy path should not error; got: {result['error']!r}"
    assert len(result["schedules"]) >= 1
    assert len(result["schedules"][0]["courses"]) == 2


# ---------------------------------------------------------------------------
# Adaptive-rmp-cap test (covers Change 2)
# ---------------------------------------------------------------------------

def test_adaptive_rmp_cap_finds_solution_when_top_10_conflict():
    # 11 sections per course. Top 10 by RMP all meet at MW 11:00 (conflict
    # pairwise across courses since both courses meet at the same time).
    # The 11th section in each course meets at a non-conflicting slot.
    # With rmp_cap=10 only, both courses' top-10 collide → no schedule.
    # The adaptive fallback should widen rmp_cap and find the rank-11 combo.
    def slot_for(i: int) -> tuple[list[str], str, str]:
        # The first 10 sections share the same MW 11:00 slot to force conflict.
        # The 11th section uses a unique non-conflicting time.
        if i < 10:
            return ["Mon", "Wed"], "11:00", "12:00"
        return ["Tue", "Thu"], "11:00", "12:00"

    def build(course: str, prefix: str) -> list[Section]:
        out = []
        for i in range(11):
            days, start, end = slot_for(i)
            # High RMP for top 10, low RMP for rank-11 so they sort to the bottom
            rmp = 4.8 if i < 10 else 2.0
            out.append(make_section(
                course, f"{prefix}{i:03d}", days, start, end,
                rmp_score=rmp, professor=f"Prof {prefix}{i}",
            ))
        return out

    sections = {
        "AAA 100": build("AAA 100", "A"),
        "BBB 100": build("BBB 100", "B"),
    }
    # AAA rank-11 is Tue/Thu 11:00; BBB rank-11 is Tue/Thu 11:00 → also conflict!
    # Fix: give BBB rank-11 a different slot.
    sections["BBB 100"][10] = make_section(
        "BBB 100", "B010", ["Tue", "Thu"], "14:00", "15:00",
        rmp_score=2.0, professor="Prof B10",
    )

    cons = base_constraints()
    result = call_solver(sections, cons, planning_mode=False)
    assert result["error"] is None, (
        f"adaptive rmp_cap should find the rank-11 combo; got error: {result['error']!r}"
    )
    assert len(result["schedules"]) >= 1


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def test_planning_mode_penalizes_constraint_violations():
    # One course with two lectures: A fits the user's 10:00-17:00 window,
    # B is at 07:00 (violates). Planning mode must surface BOTH (so the user
    # can see all options) but rank the preference-matching A higher.
    sections = {
        "CSCI 270": [
            make_section("CSCI 270", "A001", ["Mon", "Wed"], "11:00", "12:00",
                         professor="Prof Fits"),
            make_section("CSCI 270", "B001", ["Mon", "Wed"], "07:00", "08:00",
                         professor="Prof Violates"),
        ],
    }
    cons = base_constraints(earliest_start="10:00", latest_end="17:00")

    result = call_solver(sections, cons, planning_mode=True)
    assert result["error"] is None, f"planning mode should not error; got {result['error']!r}"
    assert len(result["schedules"]) >= 2, (
        f"expected at least 2 schedules in planning mode, got {len(result['schedules'])}"
    )

    # Top schedule should be the one whose section fits the window.
    top_section_ids = {c["section_id"] for c in result["schedules"][0]["courses"]}
    assert "A001" in top_section_ids, (
        f"top schedule should contain A001 (fits window), got {top_section_ids}"
    )
    # The violating schedule should also appear but with a lower score.
    scores = [s["score"] for s in result["schedules"]]
    assert scores[0] > scores[-1], (
        f"preference-matching schedule should score higher; scores={scores}"
    )


def test_planning_mode_ignores_seat_count_in_score():
    # Two lectures with identical attributes EXCEPT seat count.
    # In planning mode, score must be identical (seats neutralized).
    sections = {
        "CSCI 270": [
            make_section("CSCI 270", "FULL", ["Mon", "Wed"], "11:00", "12:00",
                         professor="Prof Full", seats_available=0, total_seats=30),
            make_section("CSCI 270", "OPEN", ["Mon", "Wed"], "13:00", "14:00",
                         professor="Prof Open", seats_available=20, total_seats=30),
        ],
    }
    cons = base_constraints()

    result = call_solver(sections, cons, planning_mode=True)
    assert result["error"] is None
    assert len(result["schedules"]) == 2

    score_by_id = {
        s["courses"][0]["section_id"]: s["score"]
        for s in result["schedules"]
    }
    assert score_by_id["FULL"] == score_by_id["OPEN"], (
        f"seat counts must not affect score in planning mode; got {score_by_id}"
    )


def _make_ge_section(course, section_id, days, start, end, category, units=4.0):
    s = make_section(course, section_id, days, start, end, units=units)
    s.ge_categories = [category]
    return s


def test_optional_ge_slots_never_block_must_have_schedules():
    # One must-have course; two optional GE slots whose only candidates
    # (a) conflict with each other in time and (b) together exceed max_units.
    # Best-effort semantics: schedules must still come back with the must-have
    # (plus at most one GE), not fail outright.
    sections = {
        "CSCI 270": [
            make_section("CSCI 270", "REQ1", ["Mon", "Wed"], "10:00", "11:00", units=4.0),
        ],
    }
    ge_candidates = {
        "Category A": [
            _make_ge_section("AHIS 120", "GEA1", ["Tue"], "13:00", "14:00", "A", units=4.0),
        ],
        "Category B": [
            _make_ge_section("PHIL 140", "GEB1", ["Tue"], "13:30", "14:30", "B", units=4.0),
        ],
    }
    ge_inputs = [
        CourseInput(input_type="ge", category="A", is_optional=True),
        CourseInput(input_type="ge", category="B", is_optional=True),
    ]
    # max_units=8: must-have (4) + one GE (4) fits, both GEs (12) does not —
    # and the two GEs overlap on Tue anyway.
    cons = base_constraints(max_units=8)

    result = build_schedules(
        must_have_inputs=[CourseInput(input_type="course", code="CSCI 270")],
        ge_inputs=ge_inputs,
        nice_to_have_inputs=[],
        all_sections=sections,
        ge_candidates=ge_candidates,
        constraints=cons,
        planning_mode=False,
    )
    assert result["error"] is None, f"expected schedules, got error: {result['error']}"
    assert result["schedules"], "optional GEs must not block must-have schedules"
    top = result["schedules"][0]
    courses = {c["course"] for c in top["courses"]}
    assert "CSCI 270" in courses
    ge_count = sum(1 for c in top["courses"] if c["entry_type"] == "ge")
    assert ge_count == 1, f"expected exactly one GE to fit, got {ge_count}"


def test_required_ge_still_fails_when_it_cannot_fit():
    # Same setup but the GEs are REQUIRED — exceeding max_units with both
    # must still produce no schedules (required semantics unchanged).
    sections = {
        "CSCI 270": [
            make_section("CSCI 270", "REQ1", ["Mon", "Wed"], "10:00", "11:00", units=4.0),
        ],
    }
    ge_candidates = {
        "Category A": [
            _make_ge_section("AHIS 120", "GEA1", ["Tue"], "13:00", "14:00", "A", units=4.0),
        ],
        "Category B": [
            _make_ge_section("PHIL 140", "GEB1", ["Tue"], "13:30", "14:30", "B", units=4.0),
        ],
    }
    ge_inputs = [
        CourseInput(input_type="ge", category="A", is_optional=False),
        CourseInput(input_type="ge", category="B", is_optional=False),
    ]
    cons = base_constraints(max_units=8)

    result = build_schedules(
        must_have_inputs=[CourseInput(input_type="course", code="CSCI 270")],
        ge_inputs=ge_inputs,
        nice_to_have_inputs=[],
        all_sections=sections,
        ge_candidates=ge_candidates,
        constraints=cons,
        planning_mode=False,
    )
    assert not result["schedules"], "required GEs that can't fit must still fail"
    assert result["error"]



# ---------------------------------------------------------------------------
# A course's own lab/discussion must not overlap its own lecture
# (PHYS 152 Fall 2026: lecture Tue/Thu 2:00-3:50 was paired with a Thu 2:00 lab)
# ---------------------------------------------------------------------------

def _lab(sid, days, start, end, stype="Lab"):
    return LinkedSection(section_id=sid, section_type=stype, days=days,
                         start_time=start, end_time=end, seats_available=5, total_seats=20)


def test_linked_section_overlapping_its_own_lecture_is_dropped():
    lecture = make_section("PHYS 152", "50404", ["Tue", "Thu"], "14:00", "15:50", linked_sections=[
        _lab("50415", ["Thu"], "14:00", "16:50"),   # clashes with the Thu lecture
        _lab("50411", ["Fri"], "11:00", "13:50"),   # fine
    ])
    cons = base_constraints(earliest_start="08:00", latest_end="20:00")
    for planning in (False, True):
        pairs, _, bundles = expand_to_pairs([lecture], cons, planning_mode=planning)
        labs = {p.linked_sections[0].section_id for p in pairs}
        assert labs == {"50411"}, (planning, labs)
        offered = {ls.section_id for ls in bundles[0].options_by_type["lab"]}
        assert offered == {"50411"}, f"the lab picker must not offer the clashing lab: {offered}"


def test_linked_sections_overlapping_each_other_are_not_combined():
    lecture = make_section("PHYS 152", "50400", ["Wed", "Fri"], "12:00", "13:50", linked_sections=[
        _lab("50403", ["Thu"], "17:00", "18:20", stype="Discussion"),
        _lab("50420", ["Thu"], "17:00", "19:50"),   # clashes with the discussion
        _lab("50406", ["Tue"], "08:00", "10:50"),
    ])
    cons = base_constraints(earliest_start="08:00", latest_end="20:00")
    pairs, _, _ = expand_to_pairs([lecture], cons, planning_mode=True)
    combos = {tuple(sorted(ls.section_id for ls in p.linked_sections)) for p in pairs}
    assert combos == {("50403", "50406")}, combos


def test_lecture_whose_only_lab_clashes_is_unschedulable():
    lecture = make_section("PHYS 152", "50404", ["Tue", "Thu"], "14:00", "15:50", linked_sections=[
        _lab("50415", ["Thu"], "14:00", "16:50"),
    ])
    cons = base_constraints(earliest_start="08:00", latest_end="20:00")
    pairs, _, _ = expand_to_pairs([lecture], cons, planning_mode=True)
    assert pairs == [], pairs
    result = call_solver({"PHYS 152": [lecture]}, cons, planning_mode=True)
    for sched in result["schedules"]:
        for c in sched["courses"]:
            assert all(ls["section_id"] != "50415" for ls in c.get("linked_sections", []) if ls), sched



# ---------------------------------------------------------------------------
# The lab/discussion prompt must only offer choices that fit the other courses
# (Fall 2026: prompt offered Peroomian's PHYS 152, whose lecture clashes with
# EE 141's 11am discussion, so every pick ended in "unavoidable conflicts")
# ---------------------------------------------------------------------------

def _prompt_fixture(other_days, other_start, other_end):
    labs = [_lab("L-fri8", ["Fri"], "08:00", "10:50"),
            _lab("L-fri11", ["Fri"], "11:00", "13:50"),
            _lab("L-wed8", ["Wed"], "08:00", "10:50")]
    phys = [
        make_section("PHYS 152", "top", ["Tue", "Thu"], "10:00", "11:50", rmp_score=4.5, linked_sections=labs),
        make_section("PHYS 152", "low", ["Tue", "Thu"], "14:00", "15:50", rmp_score=1.8, linked_sections=labs),
    ]
    other = [make_section("EE 141", "e1", other_days, other_start, other_end)]
    return {"PHYS 152": phys, "EE 141": other}


def _resolve(sections, prefs=None):
    inputs = [CourseInput(input_type="course", code="EE 141"),
              CourseInput(input_type="course", code="PHYS 152", preferred_linked_section_ids=prefs)]
    cons = base_constraints(earliest_start="08:00", latest_end="20:00")
    return resolve_must_haves(inputs, sections, cons, planning_mode=True)


def test_prompt_skips_top_rated_lecturer_that_cannot_fit():
    res = _resolve(_prompt_fixture(["Tue", "Thu"], "11:00", "11:50"))   # clashes with "top"
    assert res.needs_linked_section_prompt == "PHYS 152", (res.errors, res.needs_linked_section_prompt)
    bundles = res.linked_section_options["PHYS 152"]
    assert [b.lecture_section_id for b in bundles] == ["low"], [b.lecture_section_id for b in bundles]


def test_prompt_still_prefers_top_rated_lecturer_when_it_fits():
    res = _resolve(_prompt_fixture(["Mon"], "09:00", "09:50"))
    bundles = res.linked_section_options["PHYS 152"]
    assert [b.lecture_section_id for b in bundles] == ["top"], [b.lecture_section_id for b in bundles]


def test_prompt_drops_lab_times_that_clash_with_other_courses():
    res = _resolve(_prompt_fixture(["Fri"], "11:00", "11:50"))           # clashes with the Fri 11 lab
    labs = {ls.section_id for b in res.linked_section_options["PHYS 152"] for ls in b.options_by_type["lab"]}
    assert labs == {"L-fri8", "L-wed8"}, labs


def test_every_prompted_choice_leads_to_a_schedule():
    sections = _prompt_fixture(["Tue", "Thu"], "11:00", "11:50")
    res = _resolve(sections)
    for b in res.linked_section_options["PHYS 152"]:
        for ls in b.options_by_type["lab"]:
            picked = _resolve(sections, {"lecture_section_id": b.lecture_section_id, "lab": ls.section_id})
            assert not picked.errors and picked.combinations, (ls.section_id, picked.errors)


def test_no_prompt_when_only_one_lab_time_fits():
    sections = _prompt_fixture(["Wed", "Fri"], "08:00", "10:50")         # only the Fri 11 lab is left
    res = _resolve(sections)
    assert res.needs_linked_section_prompt is None, res.linked_section_options
    assert res.combinations and not res.errors, res.errors



# ---------------------------------------------------------------------------
# Over the unit cap: say so before any lab/discussion prompt
# ---------------------------------------------------------------------------

def test_over_unit_cap_fails_before_prompting():
    sections = _prompt_fixture(["Mon"], "09:00", "09:50")   # 4 + 4 units, and PHYS would prompt
    inputs = [CourseInput(input_type="course", code="EE 141"),
              CourseInput(input_type="course", code="PHYS 152")]
    cons = base_constraints(earliest_start="08:00", latest_end="20:00", max_units=6)
    res = resolve_must_haves(inputs, sections, cons, planning_mode=True)
    assert res.needs_linked_section_prompt is None, "must not ask for a lab time first"
    assert res.errors and "8 units" in res.errors[0] and "6-unit max" in res.errors[0], res.errors


TESTS = [
    test_planning_mode_returns_schedules_despite_tight_time_window,
    test_planning_mode_returns_schedules_despite_days_off,
    test_planning_mode_returns_schedules_despite_modality_mismatch,
    test_planning_mode_still_honors_section_id_pin,
    test_planning_mode_relaxes_no_back_to_back,
    test_strict_mode_still_works_for_happy_path,
    test_adaptive_rmp_cap_finds_solution_when_top_10_conflict,
    test_planning_mode_penalizes_constraint_violations,
    test_planning_mode_ignores_seat_count_in_score,
    test_optional_ge_slots_never_block_must_have_schedules,
    test_required_ge_still_fails_when_it_cannot_fit,
    test_linked_section_overlapping_its_own_lecture_is_dropped,
    test_linked_sections_overlapping_each_other_are_not_combined,
    test_lecture_whose_only_lab_clashes_is_unschedulable,
    test_prompt_skips_top_rated_lecturer_that_cannot_fit,
    test_prompt_still_prefers_top_rated_lecturer_when_it_fits,
    test_prompt_drops_lab_times_that_clash_with_other_courses,
    test_every_prompted_choice_leads_to_a_schedule,
    test_no_prompt_when_only_one_lab_time_fits,
    test_over_unit_cap_fails_before_prompting,
]


def main() -> int:
    passed = 0
    failed: list[tuple[str, str]] = []
    for fn in TESTS:
        name = fn.__name__
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e) or "assertion failed"))
            print(f"FAIL  {name}: {e}")
            continue
        except Exception:
            failed.append((name, traceback.format_exc()))
            print(f"ERROR {name}:")
            traceback.print_exc()
            continue
        passed += 1
        print(f"PASS  {name}")
    print()
    print(f"{passed}/{len(TESTS)} passed, {len(failed)} failed")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())

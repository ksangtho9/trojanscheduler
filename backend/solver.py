"""
solver.py — Trojan Scheduler
Part 1: Data types + pre-processing

Sections:
  1. Types          — all data structures used across the solver
  2. Pre-processing — filtering, pinning, pair expansion, discussion prompting
  3. Backtracking   — (next file)
  4. Scoring        — (next file)
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# 1. TYPES
# ---------------------------------------------------------------------------

@dataclass
class LinkedSection:
    """
    A discussion, lab, or quiz section linked to a parent lecture.
    Returned by scraper.py inside the parent Section's linked_sections list.
    """
    section_id: str
    section_type: str           # "discussion" | "lab" | "quiz"
    days: list[str]             # e.g. ["Fri"]
    start_time: str             # "HH:MM" 24h
    end_time: str               # "HH:MM" 24h
    seats_available: int
    total_seats: int
    location: str = ""


@dataclass
class Section:
    """
    One lecture section of a course, as returned by scraper.py.
    linked_sections contains all discussion/lab/quiz sections
    that are tied to this specific lecture.
    """
    course: str                 # e.g. "CSCI 270"
    section_id: str             # USC section ID e.g. "12345"
    section_type: str           # "lecture" | "seminar" | "online"
    professor: str
    days: list[str]             # e.g. ["Mon", "Wed"]
    start_time: str             # "HH:MM" 24h
    end_time: str               # "HH:MM" 24h
    location: str
    units: float
    modality: str               # "in_person" | "online" | "hybrid"
    seats_available: int
    total_seats: int
    ge_categories: list[str]    # e.g. ["C", "D"] — empty if not a GE course

    # RMP data — populated by rmp.py before solver runs
    rmp_score: float = 3.0
    rmp_difficulty: Optional[float] = None
    would_take_again: Optional[float] = None    # 0–100
    rmp_total_ratings: int = 0
    rmp_profile_url: Optional[str] = None
    no_rmp_data: bool = False

    # Linked sections (discussions, labs, quizzes)
    # Grouped by scraper — each lecture knows its own discussion options
    linked_sections: list[LinkedSection] = field(default_factory=list)

    # Filled in by solver after placement
    is_double_count: bool = False
    entry_type: str = "course"          # "course" | "ge"
    ge_slot: Optional[str] = None       # e.g. "Category C"
    runner_ups: Optional[list] = None   # populated for GE slots


@dataclass
class SectionPair:
    """
    An atomic unit for backtracking: one lecture + one linked section.
    If a course has no linked sections, linked is None.
    The solver treats each SectionPair as indivisible —
    both blocks are placed or neither is.
    """
    lecture: Section
    linked: Optional[LinkedSection]     # None if course has no discussion/lab

    @property
    def course(self) -> str:
        return self.lecture.course

    @property
    def all_days(self) -> list[str]:
        """All days occupied by this pair."""
        days = list(self.lecture.days)
        if self.linked:
            days += self.linked.days
        return days

    @property
    def seats_available(self) -> int:
        """Bottleneck seat count — min of lecture and linked section."""
        if self.linked:
            return min(self.lecture.seats_available, self.linked.seats_available)
        return self.lecture.seats_available

    @property
    def total_seats(self) -> int:
        if self.linked:
            return min(self.lecture.total_seats, self.linked.total_seats)
        return self.lecture.total_seats

    def seat_fill_ratio(self) -> float:
        """
        0.0 = empty, 1.0 = completely full.
        Used to drive the seat color gradient in the frontend.
        Formula: (total - available) / total
        """
        if self.total_seats == 0:
            return 1.0
        filled = self.total_seats - self.seats_available
        return filled / self.total_seats


@dataclass
class CourseInput:
    """
    One entry from the user's must-have or nice-to-have list.
    Supports all 5 input modes.
    """
    input_type: str                         # "course" | "ge"
    code: Optional[str] = None             # e.g. "CSCI 270" — for course mode
    professor: Optional[str] = None        # pin to specific professor
    section_id: Optional[str] = None       # pin to exact section
    category: Optional[str] = None        # e.g. "C" — for single GE mode
    categories: Optional[list[str]] = None # e.g. ["C","D"] — for multi-GE mode

    # Set by solver after pre-processing — which linked section the
    # user prefers (if they were prompted for discussion selection)
    preferred_discussion_section_id: Optional[str] = None  # section_id of chosen linked section


@dataclass
class Constraints:
    earliest_start: str         # "HH:MM"
    latest_end: str             # "HH:MM"
    days_off: list[str]         # e.g. ["Fri"]
    max_units: int              # hard cap
    no_back_to_back: bool       # if True, buffer_mins = 10
    modality: str               # "in_person" | "online" | "no_preference"


@dataclass
class ScoringWeights:
    """
    Derived from the two user-facing sliders.
    All four weights always sum to 1.0.

    prof_slider (0–1):          how much the user cares about professor quality
    convenience_slider (0–1):   how much the user cares about schedule convenience
                                (fewer days + fewer gaps)

    Seat buffer is fixed at 0.10 — always matters, not user-controlled.
    The remaining 0.90 is split between rmp, compactness, and gap
    based on the two sliders.
    """
    rmp: float
    compactness: float
    gap: float
    seat_buffer: float = 0.10

    @staticmethod
    def from_sliders(prof_slider: float, convenience_slider: float) -> "ScoringWeights":
        """
        Converts two independent 0–1 sliders into normalized weights.

        Logic:
          - Base allocation (when both sliders = 0.5):
              rmp=0.45, compactness=0.225, gap=0.225, seat=0.10
          - prof_slider scales rmp share of the 0.90 non-seat budget
          - convenience_slider splits evenly between compactness and gap
          - Both sliders are independent — maxing both is valid
            (weights are normalized so they always sum to 1.0)
        """
        # Clamp sliders to [0, 1]
        p = max(0.0, min(1.0, prof_slider))
        c = max(0.0, min(1.0, convenience_slider))

        # Raw unnormalized scores
        raw_rmp = 0.15 + p * 0.50          # range: 0.15 – 0.65
        raw_conv = c * 0.25                 # range: 0.00 – 0.25
        raw_compactness = raw_conv / 2
        raw_gap = raw_conv / 2
        raw_seat = 0.10                     # fixed

        # Normalize so all four sum to 1.0
        total = raw_rmp + raw_compactness + raw_gap + raw_seat
        return ScoringWeights(
            rmp=round(raw_rmp / total, 4),
            compactness=round(raw_compactness / total, 4),
            gap=round(raw_gap / total, 4),
            seat_buffer=round(raw_seat / total, 4),
        )


# ---------------------------------------------------------------------------
# 2. PRE-PROCESSING
# ---------------------------------------------------------------------------

def _to_minutes(t: str) -> int:
    """Convert 'HH:MM' to minutes since midnight."""
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _section_in_time_window(section: Section, constraints: Constraints) -> bool:
    """Return True if section fits within the user's earliest/latest window."""
    earliest = _to_minutes(constraints.earliest_start)
    latest = _to_minutes(constraints.latest_end)
    return (
        _to_minutes(section.start_time) >= earliest and
        _to_minutes(section.end_time) <= latest
    )


def _linked_in_time_window(linked: LinkedSection, constraints: Constraints) -> bool:
    earliest = _to_minutes(constraints.earliest_start)
    latest = _to_minutes(constraints.latest_end)
    return (
        _to_minutes(linked.start_time) >= earliest and
        _to_minutes(linked.end_time) <= latest
    )


def _modality_ok(section: Section, constraints: Constraints) -> bool:
    if constraints.modality == "no_preference":
        return True
    return section.modality == constraints.modality


def _no_day_off_conflict(days: list[str], constraints: Constraints) -> bool:
    return not any(d in constraints.days_off for d in days)


def _discussion_time_bucket(linked: LinkedSection) -> str:
    """Classify a discussion section into morning / afternoon / evening."""
    start = _to_minutes(linked.start_time)
    if start < _to_minutes("12:00"):
        return "morning"
    elif start < _to_minutes("17:00"):
        return "afternoon"
    else:
        return "evening"


def filter_and_pin_sections(
    sections: list[Section],
    course_input: CourseInput,
    constraints: Constraints,
    rmp_cap: int = 10,
) -> tuple[list[Section], Optional[str]]:
    """
    Apply all pre-processing rules to a list of raw sections for one course input.
    Returns (filtered_sections, error_message).
    error_message is None if all good, a string if we should hard-fail immediately.

    Rules applied in order:
      1. Remove sections with 0 seats
      2. Apply modality filter
      3. Apply time window filter
      4. Apply days-off filter
      5. Pin to professor (hard error if none found after filtering)
      6. Pin to section_id (hard error if not found)
      7. Cap to top-N by RMP score
    """
    # 1. Remove full sections
    result = [s for s in sections if s.seats_available > 0]
    if not result:
        return [], f"No open sections found for {course_input.code or 'this GE course'}."

    # 2. Modality
    result = [s for s in result if _modality_ok(s, constraints)]
    if not result:
        return [], (
            f"No {constraints.modality.replace('_', ' ')} sections available "
            f"for {course_input.code}."
        )

    # 3. Time window
    result = [s for s in result if _section_in_time_window(s, constraints)]
    if not result:
        return [], (
            f"No sections of {course_input.code} fall within your "
            f"{constraints.earliest_start}–{constraints.latest_end} time window."
        )

    # 4. Days off
    result = [
        s for s in result
        if _no_day_off_conflict(s.days, constraints)
    ]
    if not result:
        days_off_str = ", ".join(constraints.days_off)
        return [], (
            f"All open sections of {course_input.code} meet on your "
            f"requested day(s) off ({days_off_str})."
        )

    # 5. Professor pin
    if course_input.professor:
        pinned = [
            s for s in result
            if course_input.professor.lower() in s.professor.lower()
        ]
        if not pinned:
            return [], (
                f"Prof. {course_input.professor} has no open sections for "
                f"{course_input.code} this term."
            )
        result = pinned

    # 6. Section ID pin
    if course_input.section_id:
        pinned = [s for s in result if s.section_id == course_input.section_id]
        if not pinned:
            return [], (
                f"Section {course_input.section_id} for {course_input.code} "
                f"is not available (full or doesn't exist)."
            )
        result = pinned

    # 7. Cap to top-N by RMP
    result.sort(key=lambda s: s.rmp_score, reverse=True)
    result = result[:rmp_cap]

    return result, None


def expand_to_pairs(
    sections: list[Section],
    constraints: Constraints,
    preferred_section_id: Optional[str] = None,
) -> tuple[list[SectionPair], bool, list]:
    """
    Expand a list of lecture sections into (lecture, linked) pairs.

    If a lecture has no linked sections → pair with None.
    If a lecture has linked sections:
      - display_linked: all passing time window + day off filters (includes full sections)
      - eligible: display_linked with seats > 0 — used for actual pairing
      - If preferred_section_id is set, pin to that specific section (bypasses seats check)
      - Each valid lecture × eligible linked becomes one pair

    Returns:
      (pairs, needs_discussion_prompt, display_options)
      needs_discussion_prompt = True if eligible has 2+ distinct (days, start_time) slots
        and no preference was given yet.
      display_options = all display_linked sections (including full) — for frontend UI
    """
    pairs: list[SectionPair] = []
    needs_prompt = False
    display_options: list = []

    for section in sections:
        if not section.linked_sections:
            pairs.append(SectionPair(lecture=section, linked=None))
            continue

        # All linked sections passing time/day filters (include full for display)
        display_linked = [
            ls for ls in section.linked_sections
            if _linked_in_time_window(ls, constraints)
            and _no_day_off_conflict(ls.days, constraints)
        ]

        # Eligible for enrollment
        eligible = [ls for ls in display_linked if ls.seats_available > 0]

        if not eligible:
            continue

        if preferred_section_id:
            # Pin to the user's chosen section (may be full — respect their choice)
            chosen = next(
                (ls for ls in display_linked if ls.section_id == preferred_section_id),
                None,
            )
            if chosen:
                pairs.append(SectionPair(lecture=section, linked=chosen))
            else:
                # Chosen section not found among valid options — fall back
                for linked in sorted(eligible, key=lambda ls: -ls.seats_available):
                    pairs.append(SectionPair(lecture=section, linked=linked))
        else:
            # Check if we need to prompt: 2+ eligible sections with distinct time slots
            distinct_slots = {(tuple(ls.days), ls.start_time) for ls in eligible}
            if len(distinct_slots) >= 2:
                needs_prompt = True
                display_options.extend(display_linked)

            for linked in sorted(eligible, key=lambda ls: -ls.seats_available):
                pairs.append(SectionPair(lecture=section, linked=linked))

    return pairs, needs_prompt, display_options


def needs_discussion_prompt(sections: list[Section], constraints: Constraints) -> bool:
    """
    Quick check: should we ask the user for a discussion section preference
    before running the full solver?
    Returns True if any lecture has 2+ eligible linked sections in distinct time slots.
    """
    _, prompt, _ = expand_to_pairs(sections, constraints, preferred_section_id=None)
    return prompt


# ---------------------------------------------------------------------------
# 3. CONFLICT DETECTION
# ---------------------------------------------------------------------------

def _times_overlap(
    start_a: str, end_a: str,
    start_b: str, end_b: str,
    buffer_mins: int = 0,
) -> bool:
    """
    Return True if two time ranges overlap.
    buffer_mins enforces a minimum gap (no-back-to-back mode).
    Two classes conflict if one starts before the other ends + buffer.
    """
    s_a, e_a = _to_minutes(start_a), _to_minutes(end_a)
    s_b, e_b = _to_minutes(start_b), _to_minutes(end_b)
    return s_a < e_b + buffer_mins and s_b < e_a + buffer_mins


def _blocks_conflict(
    days_a: list[str], start_a: str, end_a: str,
    days_b: list[str], start_b: str, end_b: str,
    buffer_mins: int,
) -> bool:
    """Check if two time blocks (each with their own days) conflict."""
    shared_days = set(days_a) & set(days_b)
    if not shared_days:
        return False
    return _times_overlap(start_a, end_a, start_b, end_b, buffer_mins)


def pair_conflicts_with_pair(
    a: SectionPair,
    b: SectionPair,
    buffer_mins: int = 0,
) -> bool:
    """
    Full conflict check between two SectionPairs.
    Checks all 4 combinations:
      lecture_a vs lecture_b
      lecture_a vs linked_b
      linked_a  vs lecture_b
      linked_a  vs linked_b

    Online lectures never conflict on time with anything.
    """
    # Online sections don't conflict on time
    a_online = a.lecture.modality == "online"
    b_online = b.lecture.modality == "online"

    # lecture_a vs lecture_b
    if not (a_online and b_online):
        if _blocks_conflict(
            a.lecture.days, a.lecture.start_time, a.lecture.end_time,
            b.lecture.days, b.lecture.start_time, b.lecture.end_time,
            buffer_mins,
        ):
            return True

    # lecture_a vs linked_b
    if b.linked and not a_online:
        if _blocks_conflict(
            a.lecture.days, a.lecture.start_time, a.lecture.end_time,
            b.linked.days, b.linked.start_time, b.linked.end_time,
            buffer_mins,
        ):
            return True

    # linked_a vs lecture_b
    if a.linked and not b_online:
        if _blocks_conflict(
            a.linked.days, a.linked.start_time, a.linked.end_time,
            b.lecture.days, b.lecture.start_time, b.lecture.end_time,
            buffer_mins,
        ):
            return True

    # linked_a vs linked_b
    if a.linked and b.linked:
        if _blocks_conflict(
            a.linked.days, a.linked.start_time, a.linked.end_time,
            b.linked.days, b.linked.start_time, b.linked.end_time,
            buffer_mins,
        ):
            return True

    return False


def pair_conflicts_with_any(
    candidate: SectionPair,
    placed: list[SectionPair],
    buffer_mins: int,
) -> bool:
    """Return True if candidate conflicts with any already-placed pair."""
    return any(pair_conflicts_with_pair(candidate, p, buffer_mins) for p in placed)


# ---------------------------------------------------------------------------
# 4. BACKTRACKING ENGINE
# ---------------------------------------------------------------------------

# Returned by the backtracking engine
class SolverResult:
    def __init__(self):
        self.combinations: list[list[SectionPair]] = []
        self.errors: list[str] = []             # per-course error messages
        self.conflict_pairs: list[tuple[str, str]] = []  # (courseA, courseB) hard conflicts
        self.discussion_options: dict[str, list] = {}   # course_code → display linked sections


def _find_conflicting_pair(
    groups: list[list[SectionPair]],
    buffer_mins: int,
) -> Optional[tuple[str, str]]:
    """
    After backtracking finds zero results, identify which pair of courses
    is responsible for the deadlock.
    Tries all pairs of groups — if no combination of their pairs is
    conflict-free, they are a hard conflict.
    """
    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            group_a = groups[i]
            group_b = groups[j]
            # Check if ANY pair from group_a is compatible with ANY pair from group_b
            any_compatible = any(
                not pair_conflicts_with_pair(a, b, buffer_mins)
                for a in group_a
                for b in group_b
            )
            if not any_compatible:
                course_a = group_a[0].course if group_a else "Unknown"
                course_b = group_b[0].course if group_b else "Unknown"
                return (course_a, course_b)
    return None


def _diagnose_over_constrained(
    sections: list[Section],
    course_code: str,
    constraints: Constraints,
) -> str:
    """
    When a course has sections in the catalog but none survive filtering,
    figure out which specific constraint is too tight and return
    a human-readable message.
    """
    # Check seats
    open_sections = [s for s in sections if s.seats_available > 0]
    if not open_sections:
        return f"All sections of {course_code} are currently full."

    # Check modality
    modality_ok = [s for s in open_sections if s.modality == constraints.modality
                   or constraints.modality == "no_preference"]
    if not modality_ok:
        return (
            f"No {constraints.modality.replace('_', ' ')} sections of "
            f"{course_code} are open this term."
        )

    # Check time window
    time_ok = [s for s in modality_ok if _section_in_time_window(s, constraints)]
    if not time_ok:
        return (
            f"No open sections of {course_code} fit within your "
            f"{constraints.earliest_start}–{constraints.latest_end} window."
        )

    # Check days off
    days_off_str = ", ".join(constraints.days_off)
    return (
        f"All open sections of {course_code} meet on your day(s) off "
        f"({days_off_str})."
    )


def backtrack(
    groups: list[list[SectionPair]],   # one list of pairs per must-have course
    buffer_mins: int,
    max_combinations: int = 500,
    result: Optional[SolverResult] = None,
) -> SolverResult:
    """
    Core backtracking solver using MRV (Minimum Remaining Values) heuristic.

    Algorithm:
      1. Sort groups by number of valid pairs ascending (fewest options first)
         — this is MRV: courses with fewer choices get assigned first,
           so conflicts are discovered at the shallowest level of the tree
      2. For each group, try each pair in order
      3. If the pair doesn't conflict with anything already placed, place it
      4. Recurse to the next group
      5. If recursion succeeds, keep; else backtrack (remove and try next)
      6. Stop early once max_combinations is reached

    Args:
      groups:           list of SectionPair lists, one per must-have input
      buffer_mins:      gap buffer between classes (0 or 10)
      max_combinations: safety cap — stops exploring after this many valid combos
      result:           accumulator (created fresh if None)

    Returns:
      SolverResult with .combinations filled
    """
    if result is None:
        result = SolverResult()

    # MRV: sort groups by number of pairs ascending
    # We sort once here before recursion — the order is fixed for the whole run
    sorted_groups = sorted(groups, key=lambda g: len(g))

    def _recurse(group_idx: int, placed: list[SectionPair]) -> None:
        # Safety cap — stop exploring once we have enough
        if len(result.combinations) >= max_combinations:
            return

        # Base case: all groups assigned
        if group_idx == len(sorted_groups):
            result.combinations.append(list(placed))
            return

        current_group = sorted_groups[group_idx]

        for pair in current_group:
            if not pair_conflicts_with_any(pair, placed, buffer_mins):
                placed.append(pair)
                _recurse(group_idx + 1, placed)
                placed.pop()

    _recurse(0, [])
    return result


def resolve_must_haves(
    must_have_inputs: list[CourseInput],
    all_sections: dict[str, list[Section]],   # course_code -> sections from scraper
    constraints: Constraints,
    rmp_cap: int = 10,
    max_combinations: int = 500,
) -> SolverResult:
    """
    Full must-have resolution pipeline:
      1. Filter + pin each course's sections
      2. Expand to SectionPairs (lecture + linked)
      3. Check if discussion prompt is needed
      4. Run backtracking
      5. If zero results, diagnose why

    Args:
      must_have_inputs:  list of CourseInput from the user's form
      all_sections:      raw sections per course from scraper + rmp.py
      constraints:       user's hard constraints
      rmp_cap:           max sections per course to consider (top N by RMP)
      max_combinations:  backtracking cap

    Returns:
      SolverResult — check .combinations for valid schedules,
                     .errors for immediate hard failures,
                     .conflict_pairs for deadlock diagnosis
    """
    buffer_mins = 10 if constraints.no_back_to_back else 0
    result = SolverResult()
    groups: list[list[SectionPair]] = []

    for course_input in must_have_inputs:
        course_code = course_input.code or f"GE {course_input.category}"
        raw_sections = all_sections.get(course_code, [])

        # Filter and pin
        filtered, error = filter_and_pin_sections(
            raw_sections, course_input, constraints, rmp_cap
        )
        if error:
            result.errors.append(error)
            continue

        # Expand to pairs
        pairs, needs_prompt, options = expand_to_pairs(
            filtered,
            constraints,
            preferred_section_id=course_input.preferred_discussion_section_id,
        )

        if not pairs:
            # Sections existed but no valid pairs after linking
            msg = _diagnose_over_constrained(raw_sections, course_code, constraints)
            result.errors.append(msg)
            continue

        # Flag that a discussion prompt is needed before solving
        # The API layer handles this by returning early and asking the frontend
        if needs_prompt and course_input.preferred_discussion_section_id is None:
            result.errors.append(f"NEEDS_DISCUSSION_PROMPT:{course_code}")
            result.discussion_options[course_code] = options
            continue

        groups.append(pairs)

    # If any hard errors, return immediately — no point backtracking
    if result.errors:
        return result

    # Run backtracking
    result = backtrack(groups, buffer_mins, max_combinations, result)

    # If zero valid combinations, diagnose the deadlock
    if not result.combinations:
        conflict = _find_conflicting_pair(groups, buffer_mins)
        if conflict:
            result.conflict_pairs.append(conflict)
            result.errors.append(
                f"{conflict[0]} and {conflict[1]} have unavoidable time conflicts. "
                f"Consider prioritizing one or switching sections."
            )
        else:
            result.errors.append(
                "No valid schedule could be built with your current constraints. "
                "Try relaxing your time window or days off."
            )

    return result


# ---------------------------------------------------------------------------
# 5. GE AUTO-SELECTION (post must-have backtracking)
# ---------------------------------------------------------------------------

def auto_select_ge(
    candidates: list[Section],
    placed: list[SectionPair],
    constraints: Constraints,
    ge_slot: str,
    runner_up_count: int = 4,
    rmp_cap: int = 10,
) -> tuple[Optional[SectionPair], list[SectionPair], Optional[str]]:
    """
    From a list of GE candidate sections, pick the highest-RMP pair
    that doesn't conflict with already-placed pairs.

    Returns:
      (selected_pair, runner_ups, error_message)
      error_message is None if selection succeeded.
    """
    buffer_mins = 10 if constraints.no_back_to_back else 0

    # Filter candidates
    filtered, error = filter_and_pin_sections(
        candidates,
        CourseInput(input_type="ge"),
        constraints,
        rmp_cap,
    )
    if error or not filtered:
        return None, [], f"No valid courses found for {ge_slot}."

    # Expand to pairs
    pairs, _, _ = expand_to_pairs(filtered, constraints)
    if not pairs:
        return None, [], f"No valid courses found for {ge_slot}."

    # Sort by RMP descending, deduplicate by section_id
    seen_ids: set[str] = set()
    ranked: list[SectionPair] = []
    for pair in sorted(pairs, key=lambda p: p.lecture.rmp_score, reverse=True):
        if pair.lecture.section_id not in seen_ids:
            seen_ids.add(pair.lecture.section_id)
            ranked.append(pair)

    # Pick first non-conflicting
    valid = [p for p in ranked if not pair_conflicts_with_any(p, placed, buffer_mins)]

    if not valid:
        return None, [], f"All available courses for {ge_slot} conflict with your schedule."

    selected = valid[0]
    runner_ups = valid[1: 1 + runner_up_count]

    # Tag the selected pair
    selected.lecture.entry_type = "ge"
    selected.lecture.ge_slot = ge_slot
    selected.lecture.is_double_count = len(selected.lecture.ge_categories) >= 2

    return selected, runner_ups, None


# ---------------------------------------------------------------------------
# 6. NICE-TO-HAVE INJECTION
# ---------------------------------------------------------------------------

def inject_nice_to_haves(
    combination: list[SectionPair],
    nice_to_have_inputs: list[CourseInput],
    all_sections: dict[str, list[Section]],
    constraints: Constraints,
    max_units: int,
    rmp_cap: int = 10,
) -> list[SectionPair]:
    """
    Attempt to add nice-to-have courses to an existing combination.
    For each nice-to-have, picks the highest-RMP pair that fits.
    Respects max_units cap and conflict constraints.
    Silently skips if nothing fits — nice-to-haves are best-effort.
    """
    buffer_mins = 10 if constraints.no_back_to_back else 0
    schedule = list(combination)
    current_units = sum(p.lecture.units for p in schedule)

    for course_input in nice_to_have_inputs:
        course_code = course_input.code or ""
        raw_sections = all_sections.get(course_code, [])
        if not raw_sections:
            continue

        filtered, _ = filter_and_pin_sections(raw_sections, course_input, constraints, rmp_cap)
        if not filtered:
            continue

        pairs, _, _ = expand_to_pairs(filtered, constraints, course_input.preferred_discussion_section_id)
        if not pairs:
            continue

        # Try highest-RMP pair that fits
        pairs.sort(key=lambda p: p.lecture.rmp_score, reverse=True)
        for pair in pairs:
            if current_units + pair.lecture.units > max_units:
                continue
            if not pair_conflicts_with_any(pair, schedule, buffer_mins):
                schedule.append(pair)
                current_units += pair.lecture.units
                break

    return schedule


# ---------------------------------------------------------------------------
# 7. INDIVIDUAL SCORE COMPONENTS
# ---------------------------------------------------------------------------

def _score_rmp(schedule: list[SectionPair]) -> float:
    """
    Average RMP score across all lectures, normalized to 0–1.
    RMP scores are 0–5, so divide by 5.
    Courses with no RMP data use the 3.0 baseline — neutral, not penalized.
    """
    scores = [p.lecture.rmp_score for p in schedule]
    if not scores:
        return 0.0
    return (sum(scores) / len(scores)) / 5.0


def _score_compactness(schedule: list[SectionPair]) -> float:
    """
    Reward schedules with fewer distinct days on campus.
    Fewer days = higher score.

    Formula: 1 - (days_with_class / 5)
    Examples:
      2 days on campus → 1 - 2/5 = 0.60
      3 days on campus → 1 - 3/5 = 0.40
      5 days on campus → 1 - 5/5 = 0.00

    Online-only days don't count as "on campus."
    """
    days_on_campus: set[str] = set()
    for pair in schedule:
        if pair.lecture.modality != "online":
            days_on_campus.update(pair.lecture.days)
        if pair.linked and pair.linked.days:
            days_on_campus.update(pair.linked.days)

    return 1.0 - (len(days_on_campus) / 5.0)


def _score_gaps(schedule: list[SectionPair]) -> float:
    """
    Reward schedules with minimal dead time between classes per day.
    Score = 1 - (avg_gap_minutes / 90), clamped to [0, 1].

    90 minutes is the threshold — a gap longer than 90 min per transition
    counts as wasted time and pulls the score toward 0.

    Algorithm:
      1. Build a per-day list of all time blocks (lecture + linked)
      2. Sort blocks by start time
      3. Sum gaps between consecutive blocks
      4. Average across all transitions
    """
    # Collect all time blocks per day
    day_blocks: dict[str, list[tuple[int, int]]] = {}  # day -> [(start_min, end_min)]

    for pair in schedule:
        # Lecture block
        for day in pair.lecture.days:
            day_blocks.setdefault(day, []).append((
                _to_minutes(pair.lecture.start_time),
                _to_minutes(pair.lecture.end_time),
            ))
        # Linked section block
        if pair.linked:
            for day in pair.linked.days:
                day_blocks.setdefault(day, []).append((
                    _to_minutes(pair.linked.start_time),
                    _to_minutes(pair.linked.end_time),
                ))

    total_gap = 0
    transition_count = 0

    for day, blocks in day_blocks.items():
        sorted_blocks = sorted(blocks, key=lambda b: b[0])
        for i in range(len(sorted_blocks) - 1):
            gap = max(0, sorted_blocks[i + 1][0] - sorted_blocks[i][1])
            total_gap += gap
            transition_count += 1

    if transition_count == 0:
        return 1.0  # No gaps possible — perfect score

    avg_gap = total_gap / transition_count
    return max(0.0, 1.0 - avg_gap / 90.0)


def _score_seats(schedule: list[SectionPair]) -> float:
    """
    Reward sections with more open seats (lower risk of being dropped).

    Uses seat_fill_ratio() from SectionPair:
      0.0 = empty class   → seat score = 1.0 (great)
      1.0 = completely full → excluded before we get here (seats_available == 0)

    Formula: average of (1 - fill_ratio) across all pairs.
    Sections with few remaining seats score lower but aren't excluded
    (that's handled in pre-processing).
    """
    if not schedule:
        return 0.0
    scores = [1.0 - p.seat_fill_ratio() for p in schedule]
    return sum(scores) / len(scores)


def _seat_color_gradient(pair: SectionPair) -> str:
    """
    Returns a hex color for the seat availability gradient.
    White (#FFFFFF) when >= 70% seats remaining.
    Slides to red (#FF0000) as seats fill up.

    Formula based on raw seats remaining as a percentage of total:
      pct_remaining = seats_available / total_seats
      if pct_remaining >= 0.70 → white
      else → interpolate white→red over the 0–70% range
    """
    if pair.total_seats == 0:
        return "#FF0000"

    pct_remaining = pair.seats_available / pair.total_seats

    if pct_remaining >= 0.70:
        return "#FFFFFF"

    # Interpolate: 0% remaining = full red, 70% remaining = white
    # t=0 at pct_remaining=0, t=1 at pct_remaining=0.70
    t = pct_remaining / 0.70

    # White (255,255,255) → Red (255,0,0)
    # Only green and blue channels change
    g = round(255 * t)
    b = round(255 * t)
    return f"#{255:02X}{g:02X}{b:02X}"


# ---------------------------------------------------------------------------
# 8. COMPOSITE SCORE
# ---------------------------------------------------------------------------

def score_schedule(
    schedule: list[SectionPair],
    weights: ScoringWeights,
) -> float:
    """
    Composite schedule score 0–100.

    Each component is normalized to [0, 1] before weighting.
    Weights come from ScoringWeights.from_sliders() and always sum to 1.0.

    Components:
      rmp         — average professor rating (0–5 normalized to 0–1)
      compactness — fewer days on campus is better
      gap         — less dead time between classes is better
      seat_buffer — more open seats is better (risk management)
    """
    rmp = _score_rmp(schedule)
    compactness = _score_compactness(schedule)
    gap = _score_gaps(schedule)
    seats = _score_seats(schedule)

    raw = (
        rmp         * weights.rmp +
        compactness * weights.compactness +
        gap         * weights.gap +
        seats       * weights.seat_buffer
    )

    return round(raw * 100, 1)


# ---------------------------------------------------------------------------
# 9. SCHEDULE METADATA (for API response assembly)
# ---------------------------------------------------------------------------

def compute_schedule_metadata(schedule: list[SectionPair]) -> dict:
    """
    Compute the summary fields that sit at the top level of each
    schedule in the API response.

    Returns:
      {
        total_units: int,
        days_with_class: list[str],   # sorted Mon–Fri
        avg_rmp: float,
        gap_minutes: int,             # total gap minutes across all days
        seat_colors: dict[str, str],  # section_id -> hex color
      }
    """
    DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri"]

    # Total units
    total_units = sum(p.lecture.units for p in schedule)

    # Days with class (on campus only)
    days_on: set[str] = set()
    for pair in schedule:
        days_on.update(pair.lecture.days)
        if pair.linked:
            days_on.update(pair.linked.days)
    days_with_class = [d for d in DAY_ORDER if d in days_on]

    # Average RMP
    rmp_scores = [p.lecture.rmp_score for p in schedule]
    avg_rmp = round(sum(rmp_scores) / len(rmp_scores), 2) if rmp_scores else 0.0

    # Total gap minutes
    day_blocks: dict[str, list[tuple[int, int]]] = {}
    for pair in schedule:
        for day in pair.lecture.days:
            day_blocks.setdefault(day, []).append((
                _to_minutes(pair.lecture.start_time),
                _to_minutes(pair.lecture.end_time),
            ))
        if pair.linked:
            for day in pair.linked.days:
                day_blocks.setdefault(day, []).append((
                    _to_minutes(pair.linked.start_time),
                    _to_minutes(pair.linked.end_time),
                ))

    total_gap = 0
    for blocks in day_blocks.values():
        sorted_blocks = sorted(blocks, key=lambda b: b[0])
        for i in range(len(sorted_blocks) - 1):
            total_gap += max(0, sorted_blocks[i + 1][0] - sorted_blocks[i][1])

    # Seat color gradient per section
    seat_colors = {
        p.lecture.section_id: _seat_color_gradient(p)
        for p in schedule
    }

    return {
        "total_units": total_units,
        "days_with_class": days_with_class,
        "avg_rmp": avg_rmp,
        "gap_minutes": total_gap,
        "seat_colors": seat_colors,
    }

# ---------------------------------------------------------------------------
# 10. SCHEDULE SERIALIZATION
# ---------------------------------------------------------------------------

def _serialize_linked(linked) -> Optional[dict]:
    """Convert a LinkedSection to a dict for the API response."""
    if linked is None:
        return None
    return {
        "section_id": linked.section_id,
        "section_type": linked.section_type,
        "days": linked.days,
        "start_time": linked.start_time,
        "end_time": linked.end_time,
        "seats_available": linked.seats_available,
        "total_seats": linked.total_seats,
        "location": linked.location,
    }


def _serialize_pair(pair: SectionPair, seat_color: str) -> dict:
    """
    Convert a SectionPair into the course entry dict
    that appears in the API response under schedule.courses[].
    Matches the contract in the build plan exactly.
    """
    lec = pair.lecture
    return {
        "course": lec.course,
        "section_id": lec.section_id,
        "section_type": lec.section_type,
        "professor": lec.professor,
        "rmp_score": lec.rmp_score,
        "rmp_difficulty": lec.rmp_difficulty,
        "would_take_again": lec.would_take_again,
        "rmp_total_ratings": lec.rmp_total_ratings,
        "rmp_profile_url": lec.rmp_profile_url,
        "no_rmp_data": lec.no_rmp_data,
        "days": lec.days,
        "start_time": lec.start_time,
        "end_time": lec.end_time,
        "location": lec.location,
        "units": lec.units,
        "modality": lec.modality,
        "seats_available": lec.seats_available,
        "total_seats": lec.total_seats,
        "seat_color": seat_color,               # hex color for frontend gradient
        "ge_categories": lec.ge_categories,
        "is_double_count": lec.is_double_count,
        "double_count_categories": (
            lec.ge_categories if lec.is_double_count else []
        ),
        "entry_type": lec.entry_type,
        "ge_slot": lec.ge_slot,
        "runner_ups": _serialize_runner_ups(lec.runner_ups),
        "linked_section": _serialize_linked(pair.linked),
    }


def _serialize_runner_ups(runner_ups: Optional[list]) -> Optional[list]:
    """Serialize runner-up SectionPairs for GE swap panel."""
    if not runner_ups:
        return None
    result = []
    for r in runner_ups:
        if isinstance(r, SectionPair):
            result.append({
                "course": r.lecture.course,
                "section_id": r.lecture.section_id,
                "professor": r.lecture.professor,
                "rmp_score": r.lecture.rmp_score,
                "days": r.lecture.days,
                "start_time": r.lecture.start_time,
                "end_time": r.lecture.end_time,
                "seats_available": r.lecture.seats_available,
                "total_seats": r.lecture.total_seats,
                "linked_section": _serialize_linked(r.linked),
            })
        elif isinstance(r, dict):
            result.append(r)
    return result


# ---------------------------------------------------------------------------
# 11. DEDUPLICATION
# ---------------------------------------------------------------------------

def _deduplicate(
    scored: list[tuple[float, list[SectionPair]]],
    top_n: int,
) -> list[tuple[float, list[SectionPair]]]:
    """
    Remove near-duplicate schedules.
    Two schedules are considered duplicates if they share the exact same
    set of section IDs (lecture + linked).
    Returns top_n unique schedules sorted by score descending.
    """
    seen: set[frozenset] = set()
    unique: list[tuple[float, list[SectionPair]]] = []

    for score, schedule in sorted(scored, key=lambda x: x[0], reverse=True):
        # Build key from all section IDs in this schedule
        ids: set[str] = set()
        for pair in schedule:
            ids.add(pair.lecture.section_id)
            if pair.linked:
                ids.add(pair.linked.section_id)
        key = frozenset(ids)

        if key not in seen:
            seen.add(key)
            unique.append((score, schedule))

        if len(unique) >= top_n:
            break

    return unique


# ---------------------------------------------------------------------------
# 12. TOP-LEVEL ORCHESTRATOR
# ---------------------------------------------------------------------------

def build_schedules(
    must_have_inputs: list[CourseInput],
    ge_inputs: list[CourseInput],                   # GE slots (category or categories)
    nice_to_have_inputs: list[CourseInput],
    all_sections: dict[str, list[Section]],         # course_code -> sections from scraper
    ge_candidates: dict[str, list[Section]],        # ge_slot_name -> candidate sections
    constraints: Constraints,
    prof_slider: float = 0.5,                       # 0–1, user preference
    convenience_slider: float = 0.5,                # 0–1, user preference
    top_n: int = 3,
    rmp_cap: int = 10,
    max_combinations: int = 500,
) -> dict:
    """
    Full solver pipeline. Called by main.py after scraper + rmp.py have run.

    Pipeline:
      1. Compute scoring weights from sliders
      2. Resolve must-haves via backtracking
      3. For each valid combination:
         a. Auto-select each GE slot
         b. Inject nice-to-haves
         c. Score the full schedule
      4. Deduplicate and return top N
      5. If zero valid schedules, return structured error

    Args:
      must_have_inputs:    CourseInput list from user's must-have section
      ge_inputs:           CourseInput list for GE slots (separate from must-haves)
      nice_to_have_inputs: CourseInput list from user's nice-to-have section
      all_sections:        dict mapping course code -> list[Section] from scraper
      ge_candidates:       dict mapping GE slot name -> list[Section] from ge_finder
      constraints:         hard constraints from user's form
      prof_slider:         0–1 professor quality preference
      convenience_slider:  0–1 schedule convenience preference
      top_n:               how many schedules to return (default 3)
      rmp_cap:             max sections per course to consider before solving
      max_combinations:    backtracking safety cap

    Returns:
      {
        "schedules": [ schedule_dict, ... ],   # top N, ranked
        "error": str | None,                   # set if no schedules found
        "needs_discussion_prompt": str | None, # course code needing prompt
      }
    """

    # --- Step 1: Compute weights ---
    weights = ScoringWeights.from_sliders(prof_slider, convenience_slider)

    # --- Step 2: Resolve must-haves ---
    solver_result: SolverResult = resolve_must_haves(
        must_have_inputs,
        all_sections,
        constraints,
        rmp_cap,
        max_combinations,
    )

    # Handle discussion prompt needed
    prompt_error = next(
        (e for e in solver_result.errors if e.startswith("NEEDS_DISCUSSION_PROMPT:")),
        None,
    )
    if prompt_error:
        course_code = prompt_error.split(":")[1]
        raw_options = solver_result.discussion_options.get(course_code, [])
        options = [
            {
                "section_id": ls.section_id,
                "section_type": ls.section_type,
                "days": ls.days,
                "start_time": ls.start_time,
                "end_time": ls.end_time,
                "seats_available": ls.seats_available,
                "total_seats": ls.total_seats,
                "location": ls.location,
            }
            for ls in raw_options
        ]
        return {
            "schedules": [],
            "error": None,
            "needs_discussion_prompt": {
                "course_code": course_code,
                "options": options,
            },
        }

    # Handle hard errors
    if solver_result.errors:
        return {
            "schedules": [],
            "error": " | ".join(solver_result.errors),
            "needs_discussion_prompt": None,
        }

    if not solver_result.combinations:
        return {
            "schedules": [],
            "error": "No valid schedule could be built. Try relaxing your constraints.",
            "needs_discussion_prompt": None,
        }

    # --- Step 3: GE selection + nice-to-haves + scoring ---
    scored: list[tuple[float, list[SectionPair]]] = []

    for combination in solver_result.combinations:
        schedule = list(combination)
        ge_errors: list[str] = []

        # Auto-select each GE slot
        for ge_input in ge_inputs:
            # Build slot name for display
            if ge_input.categories:
                slot_name = "Category " + " + ".join(ge_input.categories)
                # Union of all candidate sections across requested categories
                candidates = []
                seen_ids: set[str] = set()
                for cat in ge_input.categories:
                    for sec in ge_candidates.get(f"Category {cat}", []):
                        if sec.section_id not in seen_ids:
                            candidates.append(sec)
                            seen_ids.add(sec.section_id)
            else:
                slot_name = f"Category {ge_input.category}"
                candidates = ge_candidates.get(slot_name, [])

            selected, runner_ups, error = auto_select_ge(
                candidates,
                schedule,
                constraints,
                slot_name,
                runner_up_count=4,
                rmp_cap=rmp_cap,
            )

            if error:
                ge_errors.append(error)
                break

            # Attach runner_ups to the selected section for frontend swap panel
            selected.lecture.runner_ups = runner_ups
            schedule.append(selected)

        if ge_errors:
            # This combination couldn't fill all GE slots — skip it
            continue

        # Inject nice-to-haves (best-effort, silent skip)
        schedule = inject_nice_to_haves(
            schedule,
            nice_to_have_inputs,
            all_sections,
            constraints,
            constraints.max_units,
            rmp_cap,
        )

        # Final unit cap check
        total_units = sum(p.lecture.units for p in schedule)
        if total_units > constraints.max_units:
            continue

        # Score
        final_score = score_schedule(schedule, weights)
        scored.append((final_score, schedule))

        # Early exit — we have more than enough to pick top N from
        if len(scored) >= max_combinations:
            break

    # --- Step 4: Deduplicate + rank ---
    if not scored:
        return {
            "schedules": [],
            "error": (
                "No valid schedule could be built with your GE requirements. "
                "Try broader GE categories or relax your time constraints."
            ),
            "needs_discussion_prompt": None,
        }

    top = _deduplicate(scored, top_n)

    # --- Step 5: Serialize into API response format ---
    schedules = []
    for rank, (score, schedule) in enumerate(top, start=1):
        metadata = compute_schedule_metadata(schedule)
        seat_colors = metadata.pop("seat_colors")  # used per-course, not top-level

        courses = [
            _serialize_pair(pair, seat_colors.get(pair.lecture.section_id, "#FFFFFF"))
            for pair in schedule
        ]

        schedules.append({
            "rank": rank,
            "score": score,
            "image_base64": None,       # filled by image_gen.py in main.py
            **metadata,
            "courses": courses,
        })

    return {
        "schedules": schedules,
        "error": None,
        "needs_discussion_prompt": None,
    }
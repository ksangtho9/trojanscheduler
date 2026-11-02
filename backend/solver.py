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
import copy
from dataclasses import dataclass, field
from itertools import combinations as _combinations, product as _cart_product
from typing import Optional


# GE diversity knobs ---------------------------------------------------------
# How many candidates to consider per GE slot when enumerating variants.
GE_VARIANTS_PER_SLOT = 5
# Per-combination cap on the cartesian product of GE picks (safety against
# blowup with many GE slots).
GE_VARIANTS_PER_COMBO_CAP = 40
# Score penalty per shared GE course code when picking ranks 2/3 — soft, so a
# clearly-better GE can still recur, but a tied alternative pulls ahead.
DIVERSITY_PENALTY = 3.0

# Linked-section prompt order — we surface a picker only for types that
# actually have multiple distinct slots, walking this list in order so the
# user picks discussion first (when applicable), then lab, then quiz.
LINKED_PROMPT_PRIORITY = ["discussion", "lab", "quiz"]


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
    topic: Optional[str] = None  # per-section topic (GESM "Women in Hip Hop"); None for most courses

    # USC limits this course by class level, major or school. Set by ge_finder
    # on GE candidates; auto-picked GE slots skip these.
    enrollment_limited: bool = False

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
    An atomic unit for backtracking: one lecture + one required linked section
    per type (discussion, lab, quiz, etc.).
    linked_sections is empty if the course has no linked requirements.
    The solver treats each SectionPair as indivisible.
    """
    lecture: Section
    linked_sections: list[LinkedSection] = field(default_factory=list)

    # Lazily-computed conflict blocks: (frozenset(days), start_min, end_min,
    # is_online). Precomputed once so pair_conflicts_with_pair compares integers
    # instead of re-parsing "HH:MM" strings on every call (hot path in the
    # backtracking search). Untimed blocks are dropped — they never conflict.
    _blocks_cache: Optional[list] = field(default=None, init=False, repr=False, compare=False)

    @property
    def blocks(self) -> list[tuple[frozenset, int, int, bool]]:
        if self._blocks_cache is None:
            blks: list[tuple[frozenset, int, int, bool]] = []
            lec = self.lecture
            lec_online = lec.modality == "online"
            s, e = _to_minutes(lec.start_time), _to_minutes(lec.end_time)
            if s >= 0 and e >= 0:
                blks.append((frozenset(lec.days), s, e, lec_online))
            for ls in self.linked_sections:
                ls_s, ls_e = _to_minutes(ls.start_time), _to_minutes(ls.end_time)
                if ls_s >= 0 and ls_e >= 0:
                    blks.append((frozenset(ls.days), ls_s, ls_e, False))
            self._blocks_cache = blks
        return self._blocks_cache

    @property
    def course(self) -> str:
        return self.lecture.course

    @property
    def all_days(self) -> list[str]:
        days = list(self.lecture.days)
        for ls in self.linked_sections:
            days += ls.days
        return days

    @property
    def seats_available(self) -> int:
        """Bottleneck seat count — min across lecture and all linked sections."""
        if not self.linked_sections:
            return self.lecture.seats_available
        return min(self.lecture.seats_available, *(ls.seats_available for ls in self.linked_sections))

    @property
    def total_seats(self) -> int:
        if not self.linked_sections:
            return self.lecture.total_seats
        return min(self.lecture.total_seats, *(ls.total_seats for ls in self.linked_sections))

    def seat_fill_ratio(self) -> float:
        if self.total_seats == 0:
            return 1.0
        filled = self.total_seats - self.seats_available
        return filled / self.total_seats


@dataclass
class BundleOption:
    """
    Per-lecture grouping of linked-section options for the user-facing
    'choose your discussion/lab/quiz time' prompt. Every entry in
    options_by_type comes from the same parent lecture, so picking
    across types within one bundle is guaranteed compatible (same prof).
    """
    lecture_section_id: str
    professor: str
    lecture_days: list[str]
    lecture_start_time: str
    lecture_end_time: str
    options_by_type: dict[str, list[LinkedSection]] = field(default_factory=dict)


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

    ge_code: Optional[str] = None                    # specific course within a GE category
    # True for GE inputs that came from the user's optional list — these are
    # best-effort: skip silently if no candidate fits the must-have schedule.
    is_optional: bool = False
    # Shape: {"lecture_section_id": "...", "discussion": "...", "lab": "...", "quiz": "..."}
    preferred_linked_section_ids: Optional[dict] = None


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
    """
    Convert 'HH:MM' to minutes since midnight. Returns -1 for empty / malformed
    strings — some online or arranged sections come back from the scraper
    without a time, and callers treat -1 as "no time constraint applies."
    """
    if not t or ":" not in t:
        return -1
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _block_minutes(start_time: str, end_time: str) -> Optional[tuple[int, int]]:
    """Return (start_min, end_min) for a block, or None if either is missing.
    Callers should skip None — untimed sections contribute no gap/overlap."""
    s, e = _to_minutes(start_time), _to_minutes(end_time)
    if s < 0 or e < 0:
        return None
    return (s, e)


def _section_in_time_window(section: Section, constraints: Constraints) -> bool:
    """Return True if section fits within the user's earliest/latest window."""
    earliest = _to_minutes(constraints.earliest_start)
    latest = _to_minutes(constraints.latest_end)
    start = _to_minutes(section.start_time)
    end = _to_minutes(section.end_time)
    if start < 0 or end < 0:
        return True  # untimed (online/arranged) sections never violate
    return start >= earliest and end <= latest


def _linked_in_time_window(linked: LinkedSection, constraints: Constraints) -> bool:
    earliest = _to_minutes(constraints.earliest_start)
    latest = _to_minutes(constraints.latest_end)
    start = _to_minutes(linked.start_time)
    end = _to_minutes(linked.end_time)
    if start < 0 or end < 0:
        return True
    return start >= earliest and end <= latest


def _modality_ok(section: Section, constraints: Constraints) -> bool:
    if constraints.modality == "no_preference":
        return True
    return section.modality == constraints.modality


def _no_day_off_conflict(days: list[str], constraints: Constraints) -> bool:
    return not any(d in constraints.days_off for d in days)


def _has_meeting_time(section: Section) -> bool:
    return bool(section.days) and _to_minutes(section.start_time) >= 0 and _to_minutes(section.end_time) >= 0


def _linked_has_meeting_time(ls: LinkedSection) -> bool:
    return bool(ls.days) and _to_minutes(ls.start_time) >= 0 and _to_minutes(ls.end_time) >= 0


def _prefer_timed_sections(sections: list[Section]) -> list[Section]:
    """
    Per course: if it has sections with a real meeting time, drop its
    in-person sections that have none.

    A TBA in-person section adds no days, no gaps and no conflicts, so it
    out-scored every real lecture and then drew nothing on the calendar.
    Spring 2027 CORE 104 section 63582 is a Maymester course taught in Hong
    Kong; schedules picked it over MW 3:30 and showed only the lab.
    Online sections are kept: asynchronous online classes have no time by
    design. Courses with only TBA sections are kept as they are.
    """
    timed_courses = {s.course for s in sections if _has_meeting_time(s)}
    return [
        s for s in sections
        if s.course not in timed_courses or _has_meeting_time(s) or s.modality == "online"
    ]


def filter_and_pin_sections(
    sections: list[Section],
    course_input: CourseInput,
    constraints: Constraints,
    rmp_cap: int = 10,
    planning_mode: bool = False,
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
      6b. Drop in-person sections with no meeting time when the same course
          has timed ones (see _prefer_timed_sections)
      7. Cap to top-N by RMP score
    """
    label = course_input.code or course_input.ge_code or "this course"

    # 1. Remove full sections (skipped in planning mode)
    if planning_mode:
        result = list(sections)
    else:
        result = [s for s in sections if s.seats_available > 0]
        if not result:
            return [], f"No open sections found for {label}."

    # 2. Modality (skipped in planning mode)
    if not planning_mode:
        result = [s for s in result if _modality_ok(s, constraints)]
        if not result:
            return [], (
                f"No {constraints.modality.replace('_', ' ')} sections available "
                f"for {label}."
            )

    # 3. Time window (skipped in planning mode)
    if not planning_mode:
        result = [s for s in result if _section_in_time_window(s, constraints)]
        if not result:
            return [], (
                f"No sections of {label} fall within your "
                f"{constraints.earliest_start}–{constraints.latest_end} time window."
            )

    # 4. Days off (skipped in planning mode)
    if not planning_mode:
        result = [
            s for s in result
            if _no_day_off_conflict(s.days, constraints)
        ]
        if not result:
            days_off_str = ", ".join(constraints.days_off)
            return [], (
                f"All open sections of {label} meet on your "
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

    # 6b. Prefer sections with a real meeting time. Runs after the pins so a
    # student who pins a TBA section or its professor still gets it.
    if not course_input.section_id:
        result = _prefer_timed_sections(result)

    # 7. Cap to top-N by RMP
    result.sort(key=lambda s: s.rmp_score, reverse=True)
    result = result[:rmp_cap]

    return result, None


def _linked_clashes_with_lecture(lecture: Section, linked: LinkedSection) -> bool:
    """True if a linked section meets on a lecture day at an overlapping time."""
    return _blocks_conflict(
        lecture.days, lecture.start_time, lecture.end_time,
        linked.days, linked.start_time, linked.end_time,
        buffer_mins=0,
    )


def _linked_combo_clashes(combo) -> bool:
    """True if any two linked sections in one lecture's bundle overlap."""
    items = list(combo)
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i], items[j]
            if _blocks_conflict(a.days, a.start_time, a.end_time,
                                b.days, b.start_time, b.end_time, buffer_mins=0):
                return True
    return False


def expand_to_pairs(
    sections: list[Section],
    constraints: Constraints,
    preferred_linked_section_ids: Optional[dict] = None,
    planning_mode: bool = False,
) -> tuple[list[SectionPair], Optional[str], list[BundleOption]]:
    """
    Expand lecture sections into SectionPairs, where each pair bundles one
    lecture with one required linked section per type (e.g. one discussion
    AND one lab). Uses cartesian product across type groups so every valid
    (lecture × discussion × lab × ...) combination is represented.

    Bundle grouping:
    - Each lecture produces one BundleOption containing its own linked-section
      time options grouped by type. This preserves same-professor compatibility:
      picking across types within one bundle is guaranteed to share a lecture.

    Prompt logic:
    - Only fires for a linked type if that type has 2+ distinct time slots
      across the still-eligible bundles AND the user hasn't already pinned it.
    - Walks LINKED_PROMPT_PRIORITY in order so the user picks discussion first
      (when applicable), then lab, then quiz. A subsequent round resolves the
      remaining promptable types.
    - A type with only one option is auto-picked silently (no prompt).

    preferred_linked_section_ids shape (when set):
      {"lecture_section_id": "...", "discussion": "...", "lab": "...", "quiz": "..."}
      Lectures not matching lecture_section_id are skipped entirely.

    Returns:
      (pairs, prompt_type, bundle_options)
      prompt_type is None when no prompt is needed; otherwise it names the
      linked-section type the caller should surface to the user.
    """
    pairs: list[SectionPair] = []
    bundles: list[BundleOption] = []

    pinned_lecture_id = (
        preferred_linked_section_ids.get("lecture_section_id")
        if preferred_linked_section_ids else None
    )

    for section in sections:
        if not section.linked_sections:
            # Lecture-only — but still skip if the user pinned a different lecture
            if pinned_lecture_id and section.section_id != pinned_lecture_id:
                continue
            pairs.append(SectionPair(lecture=section))
            continue

        # If user pinned a specific lecture, skip all others entirely
        if pinned_lecture_id and section.section_id != pinned_lecture_id:
            continue

        # Group by normalized type (e.g. "Discussion" → "discussion").
        # USC links labs/discussions to the whole course, not to one lecture
        # (PHYS 152 lists all 14 labs under each of its 3 lectures), so a
        # linked section can meet at the same time as this lecture. Those can
        # never be taken together, so drop them here, in planning mode too.
        by_type: dict[str, list[LinkedSection]] = {}
        for ls in section.linked_sections:
            by_type.setdefault(ls.section_type.lower(), [])
            if _linked_clashes_with_lecture(section, ls):
                continue
            by_type[ls.section_type.lower()].append(ls)
        # Like lectures (_prefer_timed_sections): a TBA lab adds no days or
        # conflicts, so it beat real lab times and left nothing on the
        # calendar (CORE 104 lab 63535 vs Mon 5pm). Keep TBA only if that is
        # all this type offers.
        for stype, group in by_type.items():
            timed = [ls for ls in group if _linked_has_meeting_time(ls)]
            if timed:
                by_type[stype] = timed

        # Filter each type by time window + days off (skipped in planning mode)
        if planning_mode:
            display_by_type: dict[str, list[LinkedSection]] = {
                stype: list(group) for stype, group in by_type.items()
            }
        else:
            display_by_type = {
                stype: [
                    ls for ls in group
                    if _linked_in_time_window(ls, constraints)
                    and _no_day_off_conflict(ls.days, constraints)
                ]
                for stype, group in by_type.items()
            }

        # Eligible = filtered + has seats (seat filter skipped in planning mode)
        eligible_by_type: dict[str, list[LinkedSection]] = {
            stype: (list(display) if planning_mode else [ls for ls in display if ls.seats_available > 0])
            for stype, display in display_by_type.items()
        }

        # If any required type has no eligible sections, this lecture is unschedulable
        if any(len(g) == 0 for g in eligible_by_type.values()):
            continue

        # Apply per-type pin within the chosen bundle
        if preferred_linked_section_ids:
            for stype in list(eligible_by_type.keys()):
                chosen_id = preferred_linked_section_ids.get(stype)
                if chosen_id:
                    pinned = [ls for ls in eligible_by_type[stype] if ls.section_id == chosen_id]
                    if pinned:
                        eligible_by_type[stype] = pinned

        # Record this lecture as a bundle option (using display lists so the
        # user sees all times, including full sections when not in planning mode)
        bundles.append(BundleOption(
            lecture_section_id=section.section_id,
            professor=section.professor,
            lecture_days=list(section.days),
            lecture_start_time=section.start_time,
            lecture_end_time=section.end_time,
            options_by_type={
                stype: list(display_by_type.get(stype, []))
                for stype in eligible_by_type.keys()
            },
        ))

        # Cartesian product across all type groups → one SectionPair per combo
        type_groups = list(eligible_by_type.values())
        for combo in _cart_product(*type_groups):
            # Skip combos whose own linked sections overlap (a lab at the
            # same time as the discussion)
            if _linked_combo_clashes(combo):
                continue
            pairs.append(SectionPair(lecture=section, linked_sections=list(combo)))

    # Prompt only for types that actually offer a choice:
    #   - If the user has pinned a lecture, restrict to that bundle.
    #   - For each linked type (walked in LINKED_PROMPT_PRIORITY), count
    #     distinct section ids across eligible bundles. ≥2 ⇒ promptable.
    #   - Pre-pinned types are skipped.
    #   - When the user has not pinned a lecture but two+ bundles share a
    #     single common slot for every type (different lecturers / same
    #     discussion time), the first promptable type still surfaces so the
    #     user can choose the lecturer through their linked pick.
    prompt_type: Optional[str] = None
    eligible_bundles = bundles
    if pinned_lecture_id:
        eligible_bundles = [b for b in bundles if b.lecture_section_id == pinned_lecture_id]

    for stype in LINKED_PROMPT_PRIORITY:
        if preferred_linked_section_ids and preferred_linked_section_ids.get(stype):
            continue
        slot_ids: set[str] = set()
        for bundle in eligible_bundles:
            for ls in bundle.options_by_type.get(stype, []):
                slot_ids.add(ls.section_id)
        if len(slot_ids) >= 2:
            prompt_type = stype
            break

    return pairs, prompt_type, bundles


def needs_linked_section_prompt(sections: list[Section], constraints: Constraints) -> bool:
    """Returns True if the user must be prompted to pick linked-section times."""
    _, prompt_type, _ = expand_to_pairs(sections, constraints, preferred_linked_section_ids=None)
    return prompt_type is not None


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
    if min(s_a, e_a, s_b, e_b) < 0:
        return False  # untimed section — treat like online: no time conflict
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
    Checks every block in a against every block in b (lecture + all linked sections).
    Online lectures never conflict on time with anything.

    Uses each pair's precomputed `blocks` (integer minutes, untimed blocks
    already dropped) so this hot-path comparison avoids re-parsing time strings.
    """
    for days_a, s_a, e_a, online_a in a.blocks:
        for days_b, s_b, e_b, online_b in b.blocks:
            if online_a and online_b:
                continue
            if days_a & days_b and s_a < e_b + buffer_mins and s_b < e_a + buffer_mins:
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
        self.errors: list[str] = []
        self.conflict_pairs: list[tuple[str, str]] = []
        self.linked_section_options: dict[str, list[BundleOption]] = {}  # course_code → bundles
        self.needs_linked_section_prompt: Optional[str] = None  # course_code
        self.prompt_type: Optional[str] = None  # "discussion" | "lab" | "quiz"


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
    planning_mode: bool = False,
) -> str:
    """
    When a course has sections in the catalog but none survive filtering,
    figure out which specific constraint is too tight and return
    a human-readable message.
    """
    # Check seats (skipped in planning mode)
    if planning_mode:
        open_sections = list(sections)
    else:
        open_sections = [s for s in sections if s.seats_available > 0]
        if not open_sections:
            return f"All sections of {course_code} are currently full."

    # Check modality (skipped in planning mode)
    if planning_mode:
        modality_ok = list(open_sections)
    else:
        modality_ok = [s for s in open_sections if s.modality == constraints.modality
                       or constraints.modality == "no_preference"]
        if not modality_ok:
            return (
                f"No {constraints.modality.replace('_', ' ')} sections of "
                f"{course_code} are open this term."
            )

    # Check time window (skipped in planning mode)
    if planning_mode:
        time_ok = list(modality_ok)
    else:
        time_ok = [s for s in modality_ok if _section_in_time_window(s, constraints)]
        if not time_ok:
            return (
                f"No open sections of {course_code} fit within your "
                f"{constraints.earliest_start}–{constraints.latest_end} window."
            )

    # Check days off — only blame days_off if the user actually set any (skipped in planning mode)
    if not planning_mode and constraints.days_off:
        days_off_ok = [s for s in time_ok if _no_day_off_conflict(s.days, constraints)]
        if not days_off_ok:
            days_off_str = ", ".join(constraints.days_off)
            return (
                f"All open sections of {course_code} meet on your "
                f"requested day(s) off ({days_off_str})."
            )

    # Lectures passed every filter — the failure must be in linked sections
    # (discussions/labs/quizzes) not fitting the time window or days off.
    return (
        f"{course_code} has open lecture sections, but no required discussion, "
        f"lab, or quiz fits your time window"
        f"{' or days off' if constraints.days_off else ''}. "
        f"Try widening the time window."
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


def _has_solution(
    groups: list[list[SectionPair]], gi: int, only: list[SectionPair], buffer_mins: int,
) -> bool:
    """True if the must-haves can all be placed with course `gi` limited to `only`."""
    if not only:
        return False
    trial = list(groups)
    trial[gi] = only
    return bool(backtrack(trial, buffer_mins, max_combinations=1).combinations)


def _feasible_prompt(
    groups: list[list[SectionPair]],
    gi: int,
    prompt_type: str,
    options: list[BundleOption],
    filtered: list[Section],
    prefs: Optional[dict],
    buffer_mins: int,
) -> Optional[list[BundleOption]]:
    """
    The bundle(s) to show in a linked-section prompt, limited to choices that
    can actually be scheduled with the other must-haves.

    Without this, the prompt offered the top-RMP lecturer even when their
    lecture clashed with another course (PHYS 152 Peroomian vs EE 141's
    11am discussion), and every pick led to "unavoidable time conflicts".

    Returns None when there is nothing worth asking: no lecturer fits (the
    backtracker will report the conflict) or only one time of this type fits.
    """
    pairs = groups[gi]
    fitting = [
        b for b in options
        if _has_solution(groups, gi, [p for p in pairs if p.lecture.section_id == b.lecture_section_id], buffer_mins)
    ]
    if not fitting:
        return None

    already_pinned = prefs is not None and prefs.get("lecture_section_id")
    if not already_pinned and len(fitting) > 1:
        rmp_by_id = {s.section_id: s.rmp_score for s in filtered}
        fitting = [max(fitting, key=lambda b: rmp_by_id.get(b.lecture_section_id, 0.0))]

    narrowed: list[BundleOption] = []
    for b in fitting:
        lecture_pairs = [p for p in pairs if p.lecture.section_id == b.lecture_section_id]
        keep = [
            ls for ls in b.options_by_type.get(prompt_type, [])
            if _has_solution(groups, gi, [
                p for p in lecture_pairs
                if any(x.section_id == ls.section_id and x.section_type.lower() == prompt_type
                       for x in p.linked_sections)
            ], buffer_mins)
        ]
        if keep:
            narrowed.append(BundleOption(
                lecture_section_id=b.lecture_section_id,
                professor=b.professor,
                lecture_days=b.lecture_days,
                lecture_start_time=b.lecture_start_time,
                lecture_end_time=b.lecture_end_time,
                options_by_type={**b.options_by_type, prompt_type: keep},
            ))
    if len({ls.section_id for b in narrowed for ls in b.options_by_type[prompt_type]}) < 2:
        return None
    return narrowed


def resolve_must_haves(
    must_have_inputs: list[CourseInput],
    all_sections: dict[str, list[Section]],   # course_code -> sections from scraper
    constraints: Constraints,
    rmp_cap: int = 10,
    max_combinations: int = 500,
    planning_mode: bool = False,
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
    buffer_mins = 0 if planning_mode else (10 if constraints.no_back_to_back else 0)
    result = SolverResult()
    groups: list[list[SectionPair]] = []
    pending_prompts: list[tuple] = []

    for course_input in must_have_inputs:
        course_code = course_input.code or f"GE {course_input.category}"
        raw_sections = all_sections.get(course_code, [])

        # Not offered this term. Planning mode skips the seat filter, so without
        # this the empty list falls through to the "no lab fits" diagnosis.
        if not raw_sections:
            result.errors.append(
                f"{course_code} isn't offered this term. Check the course code or pick a different term."
            )
            continue

        # Filter and pin
        filtered, error = filter_and_pin_sections(
            raw_sections, course_input, constraints, rmp_cap, planning_mode=planning_mode
        )
        if error:
            result.errors.append(error)
            continue

        # Expand to pairs
        pairs, prompt_type, options = expand_to_pairs(
            filtered,
            constraints,
            preferred_linked_section_ids=course_input.preferred_linked_section_ids,
            planning_mode=planning_mode,
        )

        if not pairs:
            msg = _diagnose_over_constrained(raw_sections, course_code, constraints, planning_mode=planning_mode)
            result.errors.append(msg)
            continue

        groups.append(pairs)

        # Prompt strategy (one linked type at a time, walked by priority):
        # - No prior preferences (None): prompt and narrow to the top-RMP
        #   bundle so the user sees only one lecturer's options. Their first
        #   pick implicitly chooses that lecturer.
        # - Empty preferences ({}): "no preference" signal from the user —
        #   never prompt again, let the backtracker explore everything.
        # - Non-empty preferences: honor the pins, and re-prompt for any
        #   remaining promptable type the user hasn't decided on.
        # The prompt itself is decided after every course is expanded (below),
        # because whether a lecturer or lab time can work depends on the
        # other courses.
        if prompt_type is not None:
            prefs = course_input.preferred_linked_section_ids
            if not (prefs is not None and len(prefs) == 0):
                pending_prompts.append((course_code, len(groups) - 1, prompt_type, options, filtered, prefs))

    if result.errors:
        return result

    # Units are checked only after a schedule is built, so an over-cap course
    # list used to walk the user through every lab/discussion prompt and then
    # fail with a misleading "GE requirements" error. Catch it up front.
    min_units = sum(min(p.lecture.units for p in g) for g in groups)
    if min_units > constraints.max_units:
        units = int(min_units) if float(min_units).is_integer() else min_units
        result.errors.append(
            f"Your required courses add up to {units} units, more than your "
            f"{constraints.max_units}-unit max. Raise Max units or move a course to Optional."
        )
        return result

    for course_code, gi, prompt_type, options, filtered, prefs in pending_prompts:
        prompt = _feasible_prompt(groups, gi, prompt_type, options, filtered, prefs, buffer_mins)
        if prompt is None:
            # Nothing to choose between (no lecturer fits, or only one time
            # does), so let the backtracker decide or report the conflict.
            continue
        result.needs_linked_section_prompt = course_code
        result.prompt_type = prompt_type
        result.linked_section_options[course_code] = prompt

    if result.needs_linked_section_prompt:
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

def prepare_ge_pairs(
    candidates: list[Section],
    constraints: Constraints,
    ge_slot: str,
    ge_input: "CourseInput",
    rmp_cap: int = 10,
    planning_mode: bool = False,
) -> tuple[list[SectionPair], Optional[str]]:
    """
    Placed-INDEPENDENT half of GE ranking: ge_code filter → filter/pin →
    expand to pairs → dedupe by section_id → sort by RMP descending.

    This work is identical across every must-have combination, so callers that
    rank GEs against many combinations should call this once per slot and apply
    the cheap placed-conflict filter themselves (see build_schedules).

    Returns (ranked_pairs, error). error is a string if nothing qualifies.
    """
    if ge_input.ge_code:
        candidates = [s for s in candidates if s.course.upper() == ge_input.ge_code.upper()]
        if not candidates:
            return [], f"No sections of {ge_input.ge_code} found for {ge_slot}."
    elif not ge_input.section_id and "GESM" not in [ge_input.category, *(ge_input.categories or [])]:
        # "Let the program choose": don't suggest a course the student may not
        # be allowed into. GESM 1xx counts toward A-F but is freshmen-only, so
        # sophomores were being handed seminars they can't register for. Anyone
        # who wants one can still ask: a specific class, or the GESM category.
        candidates = [s for s in candidates if not s.enrollment_limited]

    filtered, error = filter_and_pin_sections(
        candidates,
        ge_input,
        constraints,
        rmp_cap,
        planning_mode=planning_mode,
    )
    if error or not filtered:
        return [], f"No valid courses found for {ge_slot}."

    pairs, _, _ = expand_to_pairs(filtered, constraints, planning_mode=planning_mode)
    if not pairs:
        return [], f"No valid courses found for {ge_slot}."

    seen_ids: set[str] = set()
    ranked: list[SectionPair] = []
    for pair in sorted(pairs, key=lambda p: p.lecture.rmp_score, reverse=True):
        if pair.lecture.section_id not in seen_ids:
            seen_ids.add(pair.lecture.section_id)
            ranked.append(pair)

    return ranked, None


def rank_ge_candidates(
    candidates: list[Section],
    placed: list[SectionPair],
    constraints: Constraints,
    ge_slot: str,
    ge_input: "CourseInput",
    rmp_cap: int = 10,
    planning_mode: bool = False,
) -> tuple[list[SectionPair], Optional[str]]:
    """
    Return every GE pair that fits the placed schedule, ranked by RMP score
    descending and deduplicated on section_id. Empty list + error string if
    nothing qualifies.

    ge_input carries optional narrowing fields:
      ge_code    → restrict to a specific course within the category
      professor  → pin to a specific professor
      section_id → pin to an exact section
    """
    buffer_mins = 0 if planning_mode else (10 if constraints.no_back_to_back else 0)

    ranked, error = prepare_ge_pairs(
        candidates, constraints, ge_slot, ge_input,
        rmp_cap=rmp_cap, planning_mode=planning_mode,
    )
    if error:
        return [], error

    placed_courses = {p.lecture.course for p in placed}
    valid = [
        p for p in ranked
        if p.lecture.course not in placed_courses
        and not pair_conflicts_with_any(p, placed, buffer_mins)
    ]
    if not valid:
        return [], f"All available courses for {ge_slot} conflict with your schedule."

    return valid, None


def auto_select_ge(
    candidates: list[Section],
    placed: list[SectionPair],
    constraints: Constraints,
    ge_slot: str,
    ge_input: "CourseInput",
    runner_up_count: int = 4,
    rmp_cap: int = 10,
    planning_mode: bool = False,
) -> tuple[Optional[SectionPair], list[SectionPair], Optional[str]]:
    """
    Thin wrapper over rank_ge_candidates that returns the legacy
    (selected, runner_ups, error) shape. Retained for back-compat with any
    caller that still wants greedy single-pick behavior.
    """
    ranked, error = rank_ge_candidates(
        candidates, placed, constraints, ge_slot, ge_input,
        rmp_cap=rmp_cap, planning_mode=planning_mode,
    )
    if error or not ranked:
        return None, [], error

    selected = ranked[0]
    runner_ups = ranked[1: 1 + runner_up_count]

    selected.lecture.entry_type = "ge"
    selected.lecture.ge_slot = ge_slot
    selected.lecture.is_double_count = len(selected.lecture.ge_categories) >= 2

    return selected, runner_ups, None


# ---------------------------------------------------------------------------
# 6. NICE-TO-HAVE INJECTION
# ---------------------------------------------------------------------------

def prepare_nice_to_have_pairs(
    nice_to_have_inputs: list[CourseInput],
    all_sections: dict[str, list[Section]],
    constraints: Constraints,
    rmp_cap: int = 10,
    planning_mode: bool = False,
) -> list[list[SectionPair]]:
    """
    Placed-INDEPENDENT prep for nice-to-have injection: for each input, the
    filtered + expanded + RMP-sorted candidate pairs. This work is identical for
    every schedule variant (only the per-schedule units + conflict checks in
    inject_nice_to_haves vary), so compute it once and reuse it. Returns one
    pair-list per input, aligned by index with nice_to_have_inputs.
    """
    prepared: list[list[SectionPair]] = []
    for course_input in nice_to_have_inputs:
        course_code = course_input.code or ""
        raw_sections = all_sections.get(course_code, [])
        if not raw_sections:
            prepared.append([])
            continue

        filtered, _ = filter_and_pin_sections(raw_sections, course_input, constraints, rmp_cap, planning_mode=planning_mode)
        if not filtered:
            prepared.append([])
            continue

        pairs, _, _ = expand_to_pairs(filtered, constraints, course_input.preferred_linked_section_ids, planning_mode=planning_mode)
        pairs.sort(key=lambda p: p.lecture.rmp_score, reverse=True)
        prepared.append(pairs)

    return prepared


def inject_nice_to_haves(
    combination: list[SectionPair],
    nice_to_have_inputs: list[CourseInput],
    all_sections: dict[str, list[Section]],
    constraints: Constraints,
    max_units: int,
    rmp_cap: int = 10,
    planning_mode: bool = False,
    prepared_pairs: Optional[list[list[SectionPair]]] = None,
) -> list[SectionPair]:
    """
    Attempt to add nice-to-have courses to an existing combination.
    For each nice-to-have, picks the highest-RMP pair that fits.
    Respects max_units cap and conflict constraints.
    Silently skips if nothing fits — nice-to-haves are best-effort.

    prepared_pairs (from prepare_nice_to_have_pairs) lets callers that inject
    into many variants skip the repeated filter/expand/sort work. When omitted
    it is computed on the fly, preserving the original standalone behavior.
    """
    buffer_mins = 0 if planning_mode else (10 if constraints.no_back_to_back else 0)
    schedule = list(combination)
    current_units = sum(p.lecture.units for p in schedule)

    if prepared_pairs is None:
        prepared_pairs = prepare_nice_to_have_pairs(
            nice_to_have_inputs, all_sections, constraints, rmp_cap, planning_mode=planning_mode
        )

    for pairs in prepared_pairs:
        if not pairs:
            continue

        # Try highest-RMP pair that fits
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
        for ls in pair.linked_sections:
            days_on_campus.update(ls.days)

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
        lec_block = _block_minutes(pair.lecture.start_time, pair.lecture.end_time)
        if lec_block is not None:
            for day in pair.lecture.days:
                day_blocks.setdefault(day, []).append(lec_block)
        for ls in pair.linked_sections:
            ls_block = _block_minutes(ls.start_time, ls.end_time)
            if ls_block is None:
                continue
            for day in ls.days:
                day_blocks.setdefault(day, []).append(ls_block)

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

PLANNING_VIOLATION_PENALTY = 5.0


def _count_planning_violations(
    schedule: list[SectionPair],
    constraints: Constraints,
) -> int:
    """
    Count soft-preference violations across the schedule. Used only when
    planning_mode bypasses the pre-filters so violating schedules can still
    surface — but should rank lower than preference-matching ones.

    One violation per pair per dimension (time/days/modality) plus one per
    sub-buffer adjacency when no_back_to_back is set.
    """
    if not schedule:
        return 0
    violations = 0
    for pair in schedule:
        if not _modality_ok(pair.lecture, constraints):
            violations += 1
        time_bad = not _section_in_time_window(pair.lecture, constraints) or any(
            not _linked_in_time_window(ls, constraints) for ls in pair.linked_sections
        )
        if time_bad:
            violations += 1
        days_bad = not _no_day_off_conflict(pair.lecture.days, constraints) or any(
            not _no_day_off_conflict(ls.days, constraints) for ls in pair.linked_sections
        )
        if days_bad:
            violations += 1

    if constraints.no_back_to_back:
        per_day: dict[str, list[tuple[int, int]]] = {}
        for pair in schedule:
            lec_block = _block_minutes(pair.lecture.start_time, pair.lecture.end_time)
            if lec_block is not None:
                for day in pair.lecture.days:
                    per_day.setdefault(day, []).append(lec_block)
            for ls in pair.linked_sections:
                ls_block = _block_minutes(ls.start_time, ls.end_time)
                if ls_block is None:
                    continue
                for day in ls.days:
                    per_day.setdefault(day, []).append(ls_block)
        for blocks in per_day.values():
            ordered = sorted(blocks, key=lambda b: b[0])
            for i in range(len(ordered) - 1):
                gap = ordered[i + 1][0] - ordered[i][1]
                if 0 <= gap < 10:
                    violations += 1
    return violations


def score_schedule(
    schedule: list[SectionPair],
    weights: ScoringWeights,
    constraints: Optional[Constraints] = None,
    planning_mode: bool = False,
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

    In planning_mode the seat component is neutralized (seats are meaningless
    when planning ahead of registration) and each soft-preference violation
    subtracts PLANNING_VIOLATION_PENALTY points from the final score so that
    preference-matching schedules still rank highest.
    """
    rmp = _score_rmp(schedule)
    compactness = _score_compactness(schedule)
    gap = _score_gaps(schedule)
    seats = 1.0 if planning_mode else _score_seats(schedule)

    raw = (
        rmp         * weights.rmp +
        compactness * weights.compactness +
        gap         * weights.gap +
        seats       * weights.seat_buffer
    )

    final = raw * 100
    if planning_mode and constraints is not None:
        final -= PLANNING_VIOLATION_PENALTY * _count_planning_violations(schedule, constraints)
    return round(max(0.0, final), 1)


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
        for ls in pair.linked_sections:
            days_on.update(ls.days)
    days_with_class = [d for d in DAY_ORDER if d in days_on]

    # Average RMP
    rmp_scores = [p.lecture.rmp_score for p in schedule]
    avg_rmp = round(sum(rmp_scores) / len(rmp_scores), 2) if rmp_scores else 0.0

    # Total gap minutes
    day_blocks: dict[str, list[tuple[int, int]]] = {}
    for pair in schedule:
        lec_block = _block_minutes(pair.lecture.start_time, pair.lecture.end_time)
        if lec_block is not None:
            for day in pair.lecture.days:
                day_blocks.setdefault(day, []).append(lec_block)
        for ls in pair.linked_sections:
            ls_block = _block_minutes(ls.start_time, ls.end_time)
            if ls_block is None:
                continue
            for day in ls.days:
                day_blocks.setdefault(day, []).append(ls_block)

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
        "topic": lec.topic,
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
        "linked_sections": [_serialize_linked(ls) for ls in pair.linked_sections],
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
                "topic": r.lecture.topic,
                "professor": r.lecture.professor,
                "rmp_score": r.lecture.rmp_score,
                "days": r.lecture.days,
                "start_time": r.lecture.start_time,
                "end_time": r.lecture.end_time,
                "seats_available": r.lecture.seats_available,
                "total_seats": r.lecture.total_seats,
                "linked_sections": [_serialize_linked(ls) for ls in r.linked_sections],
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
    Deduplicate by LECTURE combination. Schedules that share the same set
    of lecture section IDs (same professors, same lecture days/times) are
    treated as duplicates even if their linked sections (discussion / lab /
    quiz) differ — to the user, those are variations of "the same schedule"
    and shouldn't fill multiple slots in the top-N.

    For each unique lecture combination we keep the highest-scoring variant.
    Falls back to discussion-variant fills only if there aren't enough
    distinct lecture combinations to reach top_n.
    """
    best_per_lectures: dict[frozenset, tuple[float, list[SectionPair]]] = {}
    for score, schedule in scored:
        lec_key = frozenset(p.lecture.section_id for p in schedule)
        prev = best_per_lectures.get(lec_key)
        if prev is None or score > prev[0]:
            best_per_lectures[lec_key] = (score, schedule)

    primary = sorted(
        best_per_lectures.values(),
        key=lambda x: x[0],
        reverse=True,
    )

    if len(primary) >= top_n:
        return primary[:top_n]

    # Fallback: not enough distinct lecture combos. Fill remaining slots with
    # next-best discussion variants, deduped on the full section ID set so
    # we never emit the exact same schedule twice.
    seen_full: set[frozenset] = {
        frozenset(
            sid
            for pair in sched
            for sid in [pair.lecture.section_id]
            + [ls.section_id for ls in pair.linked_sections]
        )
        for _score, sched in primary
    }
    result = list(primary)
    for score, schedule in sorted(scored, key=lambda x: x[0], reverse=True):
        full_key = frozenset(
            sid
            for pair in schedule
            for sid in [pair.lecture.section_id]
            + [ls.section_id for ls in pair.linked_sections]
        )
        if full_key in seen_full:
            continue
        seen_full.add(full_key)
        result.append((score, schedule))
        if len(result) >= top_n:
            break
    return result


def _ge_course_set(schedule: list[SectionPair]) -> set[str]:
    """Set of GE course codes in a schedule. Used by the diversity picker."""
    return {
        p.lecture.course for p in schedule
        if p.lecture.entry_type == "ge"
    }


def _diversity_aware_top_n(
    pool: list[tuple[float, list[SectionPair]]],
    top_n: int,
    penalty: float = DIVERSITY_PENALTY,
) -> list[tuple[float, list[SectionPair]]]:
    """
    Pick top_n schedules from a dedup pool, applying a soft penalty for GE
    courses already chosen by higher-ranked picks. The first pick is always
    the highest-score schedule; subsequent picks maximize
    `score - penalty * overlap_with_already_chosen_GE_courses`.

    A clearly-better schedule still wins even with overlap; tied alternatives
    pull ahead when they offer a fresh GE course.
    """
    if not pool:
        return []
    remaining = sorted(pool, key=lambda x: x[0], reverse=True)
    picked: list[tuple[float, list[SectionPair]]] = [remaining.pop(0)]
    chosen_ge_courses: set[str] = set(_ge_course_set(picked[0][1]))

    while len(picked) < top_n and remaining:
        def adjusted(item: tuple[float, list[SectionPair]]) -> float:
            score, sched = item
            overlap = len(_ge_course_set(sched) & chosen_ge_courses)
            return score - penalty * overlap

        next_pick = max(remaining, key=adjusted)
        remaining.remove(next_pick)
        picked.append(next_pick)
        chosen_ge_courses.update(_ge_course_set(next_pick[1]))

    return picked


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
    planning_mode: bool = False,
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
    # If the top rmp_cap sections deadlock against each other, widen the pool
    # and retry once or twice. Only retries on backtracking deadlocks
    # (conflict_pairs populated), not on individual-course hard failures.
    retry_caps = [rmp_cap]
    if rmp_cap < 25:
        retry_caps.append(25)
    retry_caps.append(10_000)  # effectively unlimited

    solver_result: SolverResult = SolverResult()
    for try_cap in retry_caps:
        solver_result = resolve_must_haves(
            must_have_inputs,
            all_sections,
            constraints,
            try_cap,
            max_combinations,
            planning_mode=planning_mode,
        )
        if solver_result.needs_linked_section_prompt:
            break
        if solver_result.combinations:
            break
        if not solver_result.conflict_pairs:
            # Non-deadlock failure (pinned section missing, etc.) — retry won't help
            break

    # Handle linked section prompt needed (lab/quiz/discussion courses)
    if solver_result.needs_linked_section_prompt:
        course_code = solver_result.needs_linked_section_prompt
        bundles = solver_result.linked_section_options.get(course_code, [])
        serialized_bundles = [
            {
                "lecture_section_id": b.lecture_section_id,
                "professor": b.professor,
                "lecture_days": b.lecture_days,
                "lecture_start_time": b.lecture_start_time,
                "lecture_end_time": b.lecture_end_time,
                "options_by_type": {
                    stype: [
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
                        for ls in linked_list
                    ]
                    for stype, linked_list in b.options_by_type.items()
                },
            }
            for b in bundles
        ]
        return {
            "schedules": [],
            "error": None,
            "needs_linked_section_prompt": course_code,
            "prompt_type": solver_result.prompt_type,
            "linked_section_options": {course_code: serialized_bundles},
        }

    # Handle hard errors
    if solver_result.errors:
        return {
            "schedules": [],
            "error": " | ".join(solver_result.errors),
            "needs_linked_section_prompt": None,
            "linked_section_options": {},
        }

    if not solver_result.combinations:
        return {
            "schedules": [],
            "error": "No valid schedule could be built. Try relaxing your constraints.",
            "needs_linked_section_prompt": None,
            "linked_section_options": {},
        }

    # --- Step 3: GE selection + nice-to-haves + scoring ---
    # For each must-have combination, enumerate up to K candidates per GE slot,
    # cartesian-product them into variants, prune GE↔GE conflicts, then score
    # each. This is what unlocks GE diversity across the top-N — the old code
    # greedily picked the single best GE per slot, so ranks 2/3 inherited the
    # same picks as rank 1.
    scored: list[tuple[float, list[SectionPair]]] = []
    buffer_mins = 0 if planning_mode else (10 if constraints.no_back_to_back else 0)

    # Placed-INDEPENDENT nice-to-have prep, computed once and reused for every
    # schedule variant below (only the per-schedule units + conflict checks vary).
    nice_to_have_prepared = prepare_nice_to_have_pairs(
        nice_to_have_inputs, all_sections, constraints, rmp_cap, planning_mode=planning_mode
    )

    def _slot_for(ge_input: CourseInput) -> tuple[str, list[Section]]:
        """Resolve display name + candidate pool for one GE input."""
        if ge_input.categories:
            name = "Category " + " + ".join(ge_input.categories)
            pool: list[Section] = []
            seen_ids: set[str] = set()
            for cat in ge_input.categories:
                for sec in ge_candidates.get(f"Category {cat}", []):
                    if sec.section_id not in seen_ids:
                        pool.append(sec)
                        seen_ids.add(sec.section_id)
            return name, pool
        return f"Category {ge_input.category}", ge_candidates.get(f"Category {ge_input.category}", [])

    def _materialize_ge(
        pair: SectionPair,
        slot_name: str,
        runner_ups: list[SectionPair],
    ) -> SectionPair:
        """
        Shallow-copy the chosen pair's Section so per-variant metadata
        (ge_slot, runner_ups, entry_type) doesn't leak across variants that
        share the same underlying Section instance.
        """
        new_lecture = copy.copy(pair.lecture)
        new_lecture.entry_type = "ge"
        new_lecture.ge_slot = slot_name
        new_lecture.is_double_count = len(new_lecture.ge_categories) >= 2
        new_lecture.runner_ups = runner_ups
        return SectionPair(lecture=new_lecture, linked_sections=list(pair.linked_sections))

    # Precompute the placed-INDEPENDENT GE ranking once per slot. The filter +
    # expand + dedupe + RMP-sort is identical for every must-have combination —
    # only the conflict-with-`combination` check below varies — so hoisting it
    # out of the loop avoids redoing that work up to `max_combinations` times.
    # (slot_name, ge_input, ranked_pairs) per GE input, in original order.
    prepared_ge: list[tuple[str, CourseInput, list[SectionPair]]] = []
    for ge_input in ge_inputs:
        slot_name, candidates = _slot_for(ge_input)
        ranked, _error = prepare_ge_pairs(
            candidates, constraints, slot_name,
            ge_input=ge_input, rmp_cap=rmp_cap, planning_mode=planning_mode,
        )
        prepared_ge.append((slot_name, ge_input, ranked))

    for combination in solver_result.combinations:
        # 3a. Rank candidates for each GE slot against this must-have combination.
        # Required GE: failure drops the combination. Optional GE: failure
        # silently skips that slot (matches nice-to-have semantics).
        per_slot_ranked: list[list[SectionPair]] = []
        slot_names: list[str] = []
        slot_optional: list[bool] = []
        placed_courses = {p.lecture.course for p in combination}
        failed_required = False
        for slot_name, ge_input, ranked in prepared_ge:
            valid = [
                p for p in ranked
                if p.lecture.course not in placed_courses
                and not pair_conflicts_with_any(p, combination, buffer_mins)
            ]
            if not valid:
                if ge_input.is_optional:
                    continue
                failed_required = True
                break
            slot_names.append(slot_name)
            slot_optional.append(ge_input.is_optional)
            per_slot_ranked.append(valid[:GE_VARIANTS_PER_SLOT])

        if failed_required:
            continue

        # 3b. Enumerate cartesian variants. If there are no GE slots, run once
        # with an empty combo so existing logic (nice-to-haves, scoring) still
        # fires. A None entry in a slot's option list means "skip this slot"
        # (only ever present for optional GE slots in the fallback pass).
        def _enumerate_variants(per_slot_options: list[list]) -> int:
            variant_iter = _cart_product(*per_slot_options) if per_slot_options else [()]
            variants_built = 0
            for ge_combo in variant_iter:
                if variants_built >= GE_VARIANTS_PER_COMBO_CAP:
                    break

                chosen_slots = [
                    (i, pair) for i, pair in enumerate(ge_combo) if pair is not None
                ]

                # Prune GE↔GE conflicts (high-ranked picks across slots can still
                # overlap in time).
                ge_conflict = False
                for a in range(len(chosen_slots)):
                    for b in range(a + 1, len(chosen_slots)):
                        pair_a = chosen_slots[a][1]
                        pair_b = chosen_slots[b][1]
                        if pair_a.lecture.course == pair_b.lecture.course:
                            ge_conflict = True
                            break
                        if pair_conflicts_with_pair(pair_a, pair_b, buffer_mins):
                            ge_conflict = True
                            break
                    if ge_conflict:
                        break
                if ge_conflict:
                    continue

                # Build the schedule for this variant. Each GE pair is materialized
                # via a Section copy so per-variant metadata (runner_ups, ge_slot)
                # is independent.
                schedule = list(combination)
                for i, chosen in chosen_slots:
                    runner_ups = [
                        p for p in per_slot_ranked[i]
                        if p.lecture.section_id != chosen.lecture.section_id
                    ][:4]
                    schedule.append(_materialize_ge(chosen, slot_names[i], runner_ups))

                schedule = inject_nice_to_haves(
                    schedule,
                    nice_to_have_inputs,
                    all_sections,
                    constraints,
                    constraints.max_units,
                    rmp_cap,
                    planning_mode=planning_mode,
                    prepared_pairs=nice_to_have_prepared,
                )

                total_units = sum(p.lecture.units for p in schedule)
                if total_units > constraints.max_units:
                    continue

                final_score = score_schedule(schedule, weights, constraints, planning_mode)
                scored.append((final_score, schedule))
                variants_built += 1

                if len(scored) >= max_combinations:
                    break
            return variants_built

        built = _enumerate_variants(per_slot_ranked)

        # Fallback: optional GE slots are best-effort. If forcing every slot in
        # produced zero variants (GE↔GE conflicts or unit overflow), retry while
        # skipping optional slots — fewest skips first, stopping at the first
        # skip count that yields schedules, so we keep as many optional GEs as
        # actually fit (a GE-less schedule must not outrank one with a GE that
        # fits just because it has fewer days).
        if built == 0 and any(slot_optional):
            optional_idx = [i for i, o in enumerate(slot_optional) if o]
            for n_skip in range(1, len(optional_idx) + 1):
                for skip_set in _combinations(optional_idx, n_skip):
                    fallback_options: list[list] = [
                        [None] if i in skip_set else list(ranked)
                        for i, ranked in enumerate(per_slot_ranked)
                    ]
                    built += _enumerate_variants(fallback_options)
                if built:
                    break

        if len(scored) >= max_combinations:
            break

    # --- Step 4: Deduplicate + rank ---
    if not scored:
        return {
            "schedules": [],
            "error": (
                "No valid schedule could be built with your GE requirements. "
                "Try broader GE categories or relax your time constraints."
                if ge_inputs else
                f"No schedule fits within your {constraints.max_units}-unit max. "
                "Raise Max units or move a course to Optional."
            ),
            "needs_linked_section_prompt": None,
            "linked_section_options": {},
        }

    # Build a wider dedup pool, then apply diversity-aware top-N selection so
    # ranks 2 and 3 favor schedules with different GE courses than rank 1
    # (soft penalty — clearly-better schedules still win even with overlap).
    pool = _deduplicate(scored, max(top_n * 4, top_n))
    top = _diversity_aware_top_n(pool, top_n)

    # --- Step 4b: Promote any user-pinned discussion to the top ---
    # If the user explicitly picked a discussion via the linked-section prompt,
    # the schedule containing that discussion should always surface — otherwise
    # the prompt feature feels broken when their choice gets out-scored by
    # other lecturers' bundles.
    pinned_disc_ids: set[str] = set()
    for ci in must_have_inputs:
        pref = ci.preferred_linked_section_ids
        if pref and pref.get("discussion"):
            pinned_disc_ids.add(pref["discussion"])

    if pinned_disc_ids and top:
        def _has_pinned(sched: list[SectionPair]) -> bool:
            return any(
                ls.section_id in pinned_disc_ids
                for pair in sched
                for ls in pair.linked_sections
            )

        pinned_idx = next(
            (i for i, (_s, sch) in enumerate(top) if _has_pinned(sch)),
            None,
        )
        if pinned_idx is None:
            # Pinned schedule didn't make the top — pull the best-scoring
            # pinned candidate from the full scored list and force rank 1.
            pinned_candidates = [(s, sch) for s, sch in scored if _has_pinned(sch)]
            if pinned_candidates:
                best_pinned = max(pinned_candidates, key=lambda x: x[0])
                top = [best_pinned] + top[: max(0, top_n - 1)]
        elif pinned_idx > 0:
            # In the top but not first — bubble it up to rank 1.
            top = [top[pinned_idx]] + [t for i, t in enumerate(top) if i != pinned_idx]

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
            **metadata,
            "courses": courses,
        })

    return {
        "schedules": schedules,
        "error": None,
        "needs_linked_section_prompt": None,
        "linked_section_options": {},
    }
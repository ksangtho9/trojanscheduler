# Constraint satisfaction solver — owned by The Brain
# hasConflict(a, b, buffer_mins) -> bool
# auto_select_ge(candidates, placed, buffer) -> (Section, list[Section])
# resolve_must_haves(must_haves, buffer) -> list[list[Section]] | None
# inject_nice_to_haves(combo, nice_to_haves, max_units, buffer) -> list[Section]
# flag_double_counts(schedule) -> list[Section]
# score_schedule(schedule) -> float  (0-100)

// Shared TypeScript types — mirrors the /generate API contract
// Last updated: aligned with solver.py output + mock_response.json

export type Modality = "in_person" | "online" | "hybrid" | "no_preference"

export type EntryType = "course" | "ge"

export type SectionType = "lecture" | "seminar" | "discussion" | "lab" | "quiz" | "online"

export interface DiscussionOption {
  // Discussion section
  section_id: string
  days: string[]
  start_time: string
  end_time: string
  seats_available: number
  total_seats: number
  location: string

  // Hint about which lecture this discussion belongs to. The frontend flattens
  // the backend's lecture-keyed bundles into a flat list of options; these
  // fields let the UI label the option and let us resubmit the lecture choice.
  lecture_section_id: string
  lecture_professor: string
  lecture_days: string[]
  lecture_start_time: string
  lecture_end_time: string
}

// Backend's per-lecture bundle, as returned in linked_section_options.
// Each lecture has its compatible discussion/lab/quiz options grouped under
// options_by_type. We flatten this into DiscussionOption[] for the UI.
export interface BundleLinkedSection {
  section_id: string
  section_type: string
  days: string[]
  start_time: string
  end_time: string
  seats_available: number
  total_seats: number
  location: string
}

export interface BundleOption {
  lecture_section_id: string
  professor: string
  lecture_days: string[]
  lecture_start_time: string
  lecture_end_time: string
  options_by_type: Record<string, BundleLinkedSection[]>
}

// ---------------------------------------------------------------------------
// Input types — what the frontend sends to POST /generate
// ---------------------------------------------------------------------------

export interface CourseInputEntry {
  type: "course" | "ge"
  code?: string                   // e.g. "CSCI 270" — required if type = "course"
  professor?: string              // optional professor pin
  section_id?: string             // optional exact section pin
  category?: string               // e.g. "C" — required if type = "ge" (single)
  categories?: string[]           // e.g. ["C","D"] — for multi-GE double-count hunting
  ge_code?: string                // optional specific course within the GE category
}

export interface Constraints {
  earliest_start: string          // "HH:MM" 24h
  latest_end: string              // "HH:MM" 24h
  days_off: string[]              // e.g. ["Fri"]
  max_units: number
  no_back_to_back: boolean
  modality: Modality
}

export interface GenerateRequest {
  must_haves: CourseInputEntry[]
  nice_to_haves: CourseInputEntry[]
  constraints: Constraints
  prof_slider: number             // 0–1
  convenience_slider: number      // 0–1
  planning_mode?: boolean
  // Which USC term to schedule against. Omitted means the backend's default
  // active term. An inactive term is rejected with a 400, not an empty result.
  term_code?: string
  auto_pick_mode?: boolean
  // Sent on second attempt if needs_linked_section_prompt was returned.
  // Shape: { course_code: { lecture_section_id, discussion, lab?, quiz? } }
  linked_section_preferences?: Record<string, Record<string, string>>
}

// ---------------------------------------------------------------------------
// Linked section — discussion, lab, or quiz tied to a lecture
// ---------------------------------------------------------------------------

export interface LinkedSection {
  section_id: string
  section_type: SectionType
  days: string[]
  start_time: string              // "HH:MM" 24h
  end_time: string                // "HH:MM" 24h
  seats_available: number
  total_seats: number
  location: string
}

// ---------------------------------------------------------------------------
// Runner-up — alternative GE course shown in swap panel
// ---------------------------------------------------------------------------

export interface RunnerUp {
  course: string
  section_id: string
  professor: string
  rmp_score: number
  days: string[]
  start_time: string              // "HH:MM" 24h
  end_time: string                // "HH:MM" 24h
  seats_available: number
  total_seats: number
  linked_sections: LinkedSection[]
}

// ---------------------------------------------------------------------------
// Course entry — one lecture (+ optional linked section) in a schedule
// ---------------------------------------------------------------------------

export interface CourseEntry {
  // Identity
  course: string                  // e.g. "CSCI 270"
  section_id: string
  section_type: SectionType       // "lecture" | "seminar" | etc.
  professor: string

  // RMP data
  rmp_score: number               // 0–5, defaults to 3.0 if no data
  rmp_difficulty: number | null
  would_take_again: number | null // 0–100
  rmp_total_ratings: number
  rmp_profile_url: string | null
  no_rmp_data: boolean            // true = show "No ratings" badge, not a 3.0

  // Schedule
  days: string[]                  // e.g. ["Mon", "Wed"]
  start_time: string              // "HH:MM" 24h
  end_time: string                // "HH:MM" 24h
  location: string
  units: number
  modality: string

  // Seats + color
  seats_available: number
  total_seats: number
  seat_color: string              // hex e.g. "#FFFFFF" | "#FF0000" — pre-computed by solver

  // GE info
  ge_categories: string[]         // e.g. ["C", "D"]
  is_double_count: boolean
  double_count_categories: string[] // populated when is_double_count = true

  // Slot info
  entry_type: EntryType
  ge_slot: string | null          // e.g. "Category C" — null for regular courses

  // GE swap panel
  runner_ups: RunnerUp[] | null   // null for regular courses

  // Linked discussion/lab/quiz sections (one per required type)
  linked_sections: LinkedSection[]
}

// ---------------------------------------------------------------------------
// Schedule — one complete schedule option
// ---------------------------------------------------------------------------

export interface Schedule {
  rank: number                    // 1 | 2 | 3
  score: number                   // 0–100
  total_units: number
  days_with_class: string[]       // e.g. ["Mon", "Tue", "Wed", "Thu"]
  avg_rmp: number
  gap_minutes: number             // total dead time across all days
  courses: CourseEntry[]
}

// ---------------------------------------------------------------------------
// API response — what POST /generate returns
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Term — one USC term that is currently open for registration
// ---------------------------------------------------------------------------

export interface Term {
  term_code: string               // e.g. "20263" — YYYY + season digit
  label: string                   // e.g. "Fall 2026"
  season: string                  // "Spring" | "Summer" | "Fall"
  year: number
}

// What GET /terms returns. `default` is the term the app preselects.
export interface TermsResponse {
  terms: Term[]                   // active terms, newest first
  default: string
}

export interface GenerateResponse {
  schedules: Schedule[]
  error: string | null
  // FastAPI's error body. Present only on a non-2xx response (an inactive term
  // is a 400, an upstream outage a 503), never alongside `schedules`. Modelled
  // here so the client can surface the backend's own wording instead of
  // guessing from a missing `schedules` array.
  detail?: string
  // The term the backend actually scheduled against, echoed back so results
  // are labelled with the resolved term rather than the requested one.
  term_code?: string
  term_label?: string
  // Course code that still needs the user to pick a linked-section combo.
  needs_linked_section_prompt: string | null
  // Which linked-section type the user needs to choose right now. The backend
  // surfaces one type at a time (discussion → lab → quiz, in that priority),
  // skipping any type that has only one option.
  prompt_type?: "discussion" | "lab" | "quiz" | null
  // Backend's raw shape: course_code -> list of per-lecture bundles.
  // The frontend flattens this into LinkedSectionOption[] for the prompt UI.
  linked_section_options: Record<string, BundleOption[]>
}

// ---------------------------------------------------------------------------
// UI state types — used inside page.tsx and components
// ---------------------------------------------------------------------------

export type AppStage = "form" | "loading" | "results" | "detail"

// Local state after user swaps a GE course in the detail view
// The image stays frozen — only the course list updates
export interface SwapState {
  [section_id: string]: CourseEntry  // original section_id -> replacement CourseEntry
}
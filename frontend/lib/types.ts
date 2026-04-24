// Shared TypeScript types — mirrors the /generate API contract
// Last updated: aligned with solver.py output + mock_response.json

export type Modality = "in_person" | "online" | "hybrid" | "no_preference"

export type EntryType = "course" | "ge"

export type SectionType = "lecture" | "seminar" | "discussion" | "lab" | "quiz" | "online"

export type DiscussionTimePref = "morning" | "afternoon" | "evening"

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
  // Sent on second attempt if needs_discussion_prompt was returned
  discussion_preferences?: Record<string, DiscussionTimePref>
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
  linked_section: LinkedSection | null
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

  // Linked discussion/lab/quiz
  linked_section: LinkedSection | null
}

// ---------------------------------------------------------------------------
// Schedule — one complete schedule option
// ---------------------------------------------------------------------------

export interface Schedule {
  rank: number                    // 1 | 2 | 3
  score: number                   // 0–100
  image_base64: string            // base64 PNG from image_gen.py
  total_units: number
  days_with_class: string[]       // e.g. ["Mon", "Tue", "Wed", "Thu"]
  avg_rmp: number
  gap_minutes: number             // total dead time across all days
  courses: CourseEntry[]
}

// ---------------------------------------------------------------------------
// API response — what POST /generate returns
// ---------------------------------------------------------------------------

export interface GenerateResponse {
  schedules: Schedule[]
  error: string | null            // set when no valid schedule could be built
  needs_discussion_prompt: string | null  // course code that needs time preference
                                          // frontend re-submits with discussion_preferences
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
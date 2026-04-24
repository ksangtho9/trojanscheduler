// Shared TypeScript types — mirrors the /generate API contract

export type Modality = "in_person" | "online" | "no_preference"

export type EntryType = "course" | "ge"

export interface RunnerUp {
  course: string
  professor: string
  rmp_score: number
  days: string[]
  start_time: string
  end_time: string
}

export interface CourseEntry {
  course: string
  section_id: string
  professor: string
  rmp_score: number
  rmp_difficulty: number | null
  would_take_again: number | null
  rmp_total_ratings: number
  rmp_profile_url: string
  days: string[]
  start_time: string
  end_time: string
  location: string
  units: number
  modality: string
  ge_categories: string[]
  is_double_count: boolean
  double_count_categories?: string[]
  entry_type: EntryType
  ge_slot?: string
  runner_ups: RunnerUp[] | null
}

export interface Schedule {
  rank: number
  score: number
  image_base64: string
  total_units: number
  days_with_class: string[]
  avg_rmp: number
  gap_minutes: number
  courses: CourseEntry[]
}

export interface GenerateResponse {
  schedules: Schedule[]
  error?: string
}

export interface Constraints {
  earliest_start: string
  latest_end: string
  days_off: string[]
  max_units: number
  no_back_to_back: boolean
  modality: Modality
}

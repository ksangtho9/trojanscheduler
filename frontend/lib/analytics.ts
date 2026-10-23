// Product analytics (PostHog).
//
// Everything is a no-op until NEXT_PUBLIC_POSTHOG_KEY is set, so local dev and
// forks send nothing. No names, emails or course lists are sent: only counts,
// the term, and which settings were used. Visitors are recognised by an
// anonymous id in localStorage (no cookies), which is what makes "new users"
// and "daily unique users" countable.
//
// Page views are captured automatically. Custom events:
//   schedules_generated         a student got schedules back
//   schedule_generation_failed  the attempt ended in an error message
//   schedule_selected           a schedule card was opened
//   course_swapped              a section was swapped in the detail view
//   schedule_exported           a schedule was downloaded as .ics
//   onboarding_*                first-visit guide: shown, tour started, skipped (where), completed

import posthog from "posthog-js"

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"

let started = false

export function initAnalytics(): void {
  if (started || !KEY || typeof window === "undefined") return
  posthog.init(KEY, {
    api_host: HOST,
    defaults: "2025-05-24",
    persistence: "localStorage",
    person_profiles: "always",
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
  })
  started = true
}

export type GenerationFailureReason =
  | "http_4xx"
  | "http_5xx"
  | "bad_response"
  | "no_schedules"
  | "auto_pick_unresolved"
  | "timeout"
  | "network"

type EventProps = {
  schedules_generated: {
    term_code?: string
    required_count: number
    optional_count: number
    schedules_returned: number
    auto_pick: boolean
    planning_mode: boolean
    duration_ms: number
  }
  schedule_generation_failed: {
    term_code?: string
    reason: GenerationFailureReason
    status?: number
  }
  schedule_selected: { rank: number }
  course_swapped: { rank: number }
  schedule_exported: { term_code?: string; rank: number; course_count: number }
  onboarding_shown: Record<string, never>
  onboarding_tour_started: { source: "welcome" | "help" }
  onboarding_skipped: { at: string }
  onboarding_completed: Record<string, never>
}

export function track<E extends keyof EventProps>(event: E, props: EventProps[E]): void {
  if (!started) return
  posthog.capture(event, props)
}

/** Milliseconds since `start` (a Date.now() value). Kept outside components so
 *  React's purity lint doesn't mistake an event-handler timing for render work. */
export function msSince(start: number): number {
  return Date.now() - start
}

"use client"

import { useState } from "react"
import InputForm from "@/components/InputForm"
import LeftPanel from "@/components/LeftPanel"
import LoadingScreen from "@/components/LoadingScreen"
import ScheduleImageCard from "@/components/ScheduleImageCard"
import ScheduleDetail from "@/components/ScheduleDetail"
import {
  AppStage,
  DiscussionOption,
  GenerateRequest,
  GenerateResponse,
  Schedule,
  SwapState,
} from "@/lib/types"

// Small anti-flicker floor: keep the loading screen up just long enough to
// avoid a flash when the backend is very fast, while otherwise reflecting true
// backend latency (no artificial multi-second hold).
const MIN_LOADING_MS = 600

// Ceiling on one /generate round trip. The backend's own read timeout is 120s
// because some USC department endpoints genuinely take ~110s, so this sits just
// above that: long enough for a legitimately slow scrape, short enough that a
// hung request surfaces an error instead of leaving the loading screen up.
const GENERATE_TIMEOUT_MS = 150_000

// Auto-pick resubmits once per course that still needs a linked-section choice,
// so depth is bounded by the course count. This is the backstop for a backend
// that re-asks for a course we already answered.
const MAX_AUTO_PICK_ROUNDS = 12
const waitForMinLoading = (start: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, MIN_LOADING_MS - (Date.now() - start))))

export default function Home() {
  const [stage, setStage] = useState<AppStage>("form")
  const [response, setResponse] = useState<GenerateResponse | null>(null)
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null)
  const [swapState, setSwapState] = useState<SwapState>({})
  const [error, setError] = useState<string | null>(null)
  const [discussionPromptCourse, setDiscussionPromptCourse] = useState<string | null>(null)
  const [discussionOptions, setDiscussionOptions] = useState<DiscussionOption[]>([])
  // Which linked-section type is currently being prompted ("discussion" | "lab" | "quiz").
  // Tracked so the picker UI labels itself correctly and submits to the right key.
  const [promptType, setPromptType] = useState<"discussion" | "lab" | "quiz">("discussion")
  const [pendingPayload, setPendingPayload] = useState<GenerateRequest | null>(null)
  const [planningMode, setPlanningMode] = useState(true)
  const [autoPickMode, setAutoPickMode] = useState(false)

  const callGenerate = async (payload: GenerateRequest, autoPickDepth = 0) => {
    setError(null)
    setStage("loading")
    const loadingStart = Date.now()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)
    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000"
      const res = await fetch(`${backendUrl}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      )

      // Parse defensively: a proxy's 502 is HTML, and throwing here would
      // report an upstream outage as a network failure.
      let data: GenerateResponse | null = null
      try {
        data = (await res.json()) as GenerateResponse
      } catch {
        data = null
      }

      // A failed response still carries the backend's own explanation, as
      // FastAPI's {"detail": ...}. Without this check it parses cleanly, falls
      // through to the no-schedules branch below, and an invalid term or an
      // upstream outage gets shown to the student as "adjust your constraints".
      if (!res.ok || !data) {
        setError(
          data?.detail ??
            data?.error ??
            (res.status >= 500
              ? "The scheduler is having trouble reaching USC's Schedule of Classes. Please try again in a moment."
              : `Request failed (${res.status}). Please try again.`)
        )
        setStage("form")
        return
      }

      if (data.needs_linked_section_prompt) {
        const course = data.needs_linked_section_prompt

        // Auto pick: skip the picker and resubmit with no preference
        if (payload.auto_pick_mode) {
          if (autoPickDepth >= MAX_AUTO_PICK_ROUNDS) {
            setError(
              "Couldn't resolve section times automatically. Turn off auto-pick to choose them yourself."
            )
            setStage("form")
            return
          }
          const existing = payload.linked_section_preferences ?? {}
          callGenerate(
            {
              ...payload,
              linked_section_preferences: { ...existing, [course]: {} },
            },
            autoPickDepth + 1
          )
          return
        }

        const bundles = data.linked_section_options?.[course] ?? []
        // The backend tells us which linked type to surface (discussion / lab /
        // quiz). A type with only one option never gets prompted — the backend
        // already auto-picks it. We flatten by THAT type so the picker shows
        // the right options. Each option still carries its parent lecture so
        // we can re-pin both ids on resubmit.
        const ptype = data.prompt_type ?? "discussion"
        const flatOptions: DiscussionOption[] = bundles.flatMap((b) =>
          (b.options_by_type?.[ptype] ?? []).map((d) => ({
            section_id: d.section_id,
            days: d.days,
            start_time: d.start_time,
            end_time: d.end_time,
            seats_available: d.seats_available,
            total_seats: d.total_seats,
            location: d.location,
            lecture_section_id: b.lecture_section_id,
            lecture_professor: b.professor,
            lecture_days: b.lecture_days,
            lecture_start_time: b.lecture_start_time,
            lecture_end_time: b.lecture_end_time,
          }))
        )
        setPromptType(ptype)
        setDiscussionPromptCourse(course)
        setDiscussionOptions(flatOptions)
        setPendingPayload(payload)
        setStage("form")
        return
      }

      if (data.error || !data.schedules?.length) {
        setError(data.error ?? "No valid schedules found. Try adjusting your constraints.")
        setStage("form")
        return
      }

      await waitForMinLoading(loadingStart)
      setResponse(data)
      setSwapState({})
      setStage("results")
    } catch (err) {
      setError(
        (err as Error)?.name === "AbortError"
          ? "This took longer than expected and timed out. USC's catalogue can be slow — please try again."
          : "Could not reach the server. Please try again."
      )
      setStage("form")
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const handleSubmit = (payload: GenerateRequest) => {
    setPlanningMode(payload.planning_mode ?? true)
    setAutoPickMode(payload.auto_pick_mode ?? false)
    setPendingPayload(payload)
    callGenerate(payload)
  }

  const handleDiscussionPreference = (
    pref: Record<string, Record<string, string>>
  ) => {
    if (!pendingPayload) return
    // Deep-merge per course so round 2 (lab pick) doesn't blow away round 1's
    // discussion + lecture pins. Spread alone would replace the course value.
    const existing = pendingPayload.linked_section_preferences ?? {}
    const merged: Record<string, Record<string, string>> = { ...existing }
    for (const [course, courseRef] of Object.entries(pref)) {
      merged[course] = { ...(existing[course] ?? {}), ...courseRef }
    }
    const updated: GenerateRequest = {
      ...pendingPayload,
      linked_section_preferences: merged,
    }
    setDiscussionPromptCourse(null)
    callGenerate(updated)
  }

  const handleSelect = (schedule: Schedule) => {
    // Clicking the already-selected card deselects it and returns to the
    // pre-detail comparison view.
    if (selectedSchedule?.rank === schedule.rank) {
      setSelectedSchedule(null)
      setSwapState({})
      setStage("results")
      window.scrollTo({ top: 0, behavior: "smooth" })
      return
    }
    // Clicking a different card switches the detail view to that schedule.
    setSelectedSchedule(schedule)
    setSwapState({})
    setStage("detail")
    setTimeout(() => {
      document.getElementById("detail-section")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    }, 120)
  }

  const handleStartOver = () => {
    setStage("form")
    setResponse(null)
    setSelectedSchedule(null)
    setSwapState({})
    setError(null)
    setDiscussionPromptCourse(null)
    setPendingPayload(null)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const currentStep: 1 | 2 | 3 = stage === "loading" ? 2 : stage === "form" ? 1 : 3

  // The form stage uses InputForm's own shell (LeftPanel + content area).
  // For loading/results/detail we reproduce the same shell here so the layout
  // stays identical across the whole app.
  if (stage === "form") {
    return (
      <InputForm
        onSubmit={handleSubmit}
        error={error}
        discussionPromptCourse={discussionPromptCourse}
        discussionOptions={discussionOptions}
        promptType={promptType}
        onDiscussionPreference={handleDiscussionPreference}
      />
    )
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <LeftPanel currentStep={currentStep} onStartOver={stage === "results" || stage === "detail" ? handleStartOver : undefined} />
      <div
        style={{
          marginLeft: "var(--content-offset)",
          width: "var(--content-width)",
          minHeight: "100vh",
          backgroundColor: "var(--bg-page)",
        }}
      >
        {stage === "loading" && <LoadingScreen />}

        {(stage === "results" || stage === "detail") && response && (
          <div className="app-results-inner" style={{ maxWidth: 1280, margin: "0 auto", paddingTop: "calc(var(--topbar-height) + 56px)", paddingRight: 64, paddingBottom: 96, paddingLeft: 64 }}>

            {/* Page title */}
            <div style={{ marginBottom: 48 }}>
              <p
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "var(--cardinal)",
                  marginBottom: 14,
                }}
              >
                {stage === "results"
                  ? `${String(response.schedules.length).padStart(2, "0")} Options`
                  : "Selected"}
                {response.term_label && (
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {"  \u00B7  "}{response.term_label}
                  </span>
                )}
              </p>
              <h2
                style={{
                  fontFamily: "'DM Serif Display', serif",
                  color: "var(--text-primary)",
                  fontSize: 44,
                  lineHeight: 1.05,
                  letterSpacing: "-0.01em",
                  marginBottom: 12,
                }}
              >
                {stage === "results" ? "Your schedules." : "Schedule selected."}
              </h2>
              <p style={{ color: "var(--text-tertiary)", fontSize: 15, maxWidth: 520, lineHeight: 1.6 }}>
                {stage === "results"
                  ? "Three best builds, ranked by professor quality, compactness, and minimal gaps. Pick one to drill in."
                  : "Scroll down to see every course, swap GE choices, or export to your calendar."}
              </p>
            </div>

            {/* Schedule image cards */}
            <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 28, marginBottom: 48 }}>
              {response.schedules.map((sched) => (
                <ScheduleImageCard
                  key={sched.rank}
                  schedule={sched}
                  label={["A", "B", "C"][sched.rank - 1]}
                  isSelected={selectedSchedule?.rank === sched.rank}
                  dimmed={stage === "detail" && selectedSchedule?.rank !== sched.rank}
                  onSelect={handleSelect}
                  planningMode={planningMode}
                />
              ))}
            </div>

            {/* Detail section */}
            {stage === "detail" && selectedSchedule && (
              <div id="detail-section">
                <ScheduleDetail
                  schedule={selectedSchedule}
                  swapState={swapState}
                  onSwap={(originalId, replacement) =>
                    setSwapState((prev) => ({ ...prev, [originalId]: replacement }))
                  }
                  onStartOver={handleStartOver}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
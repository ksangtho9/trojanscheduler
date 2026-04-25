"use client"

import { useState } from "react"
import InputForm from "@/components/InputForm"
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

export default function Home() {
  const [stage, setStage] = useState<AppStage>("form")
  const [response, setResponse] = useState<GenerateResponse | null>(null)
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null)
  const [swapState, setSwapState] = useState<SwapState>({})
  const [error, setError] = useState<string | null>(null)
  const [discussionPromptCourse, setDiscussionPromptCourse] = useState<string | null>(null)
  const [discussionOptions, setDiscussionOptions] = useState<DiscussionOption[]>([])
  const [pendingPayload, setPendingPayload] = useState<GenerateRequest | null>(null)

  const callGenerate = async (payload: GenerateRequest) => {
    setError(null)
    setStage("loading")
    try {
      const res = await fetch(
        process.env.NEXT_PUBLIC_BACKEND_URL
          ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/generate`
          : "/api/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      )
      const data: GenerateResponse = await res.json()

      if (data.needs_discussion_prompt) {
        setDiscussionPromptCourse(data.needs_discussion_prompt)
        setDiscussionOptions(data.discussion_options ?? [])
        setPendingPayload(payload)
        setStage("form")
        return
      }

      if (data.error || !data.schedules?.length) {
        setError(data.error ?? "No valid schedules found. Try adjusting your constraints.")
        setStage("form")
        return
      }

      setResponse(data)
      setSwapState({})
      setStage("results")
    } catch {
      setError("Could not reach the server. Please try again.")
      setStage("form")
    }
  }

  const handleSubmit = (payload: GenerateRequest) => {
    setPendingPayload(payload)
    callGenerate(payload)
  }

  const handleDiscussionPreference = (pref: Record<string, string>) => {
    if (!pendingPayload) return
    const updated: GenerateRequest = {
      ...pendingPayload,
      discussion_preferences: pref as Record<string, string>,
    }
    setDiscussionPromptCourse(null)
    callGenerate(updated)
  }

  const handleSelect = (schedule: Schedule) => {
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

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>

      {/* ── Top bar — cardinal red like webreg ── */}
      <div style={{ backgroundColor: "var(--cardinal)" }} className="px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded flex items-center justify-center font-bold text-sm"
            style={{ backgroundColor: "var(--cardinal-dark)", color: "var(--gold)" }}
          >
            TS
          </div>
          <span className="text-white font-semibold text-lg tracking-tight"
            style={{ fontFamily: "'DM Serif Display', serif" }}>
            Trojan Scheduler
          </span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-white/70 text-sm hidden md:block">
            USC · Fall 2025
          </span>
          {(stage === "results" || stage === "detail") && (
            <button
              onClick={handleStartOver}
              className="text-white/80 hover:text-white text-sm transition-colors underline underline-offset-2"
            >
              Start Over
            </button>
          )}
        </div>
      </div>

      {/* ── Secondary nav bar — dark red like webreg ── */}
      <div style={{ backgroundColor: "var(--cardinal-dark)" }} className="px-6 py-2 flex items-center gap-1">
        <div
          className="px-4 py-1.5 rounded text-sm font-medium"
          style={{ backgroundColor: "var(--cardinal)", color: "var(--gold)" }}
        >
          Schedule Builder
        </div>
        {(stage === "results" || stage === "detail") && (
          <>
            <div className="px-4 py-1.5 text-sm text-white/50">
              Results
            </div>
            {stage === "detail" && (
              <div className="px-4 py-1.5 text-sm text-white/50">
                Detail View
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Main content ── */}
      <main>
        {stage === "form" && (
          <InputForm
            onSubmit={handleSubmit}
            error={error}
            discussionPromptCourse={discussionPromptCourse}
            discussionOptions={discussionOptions}
            onDiscussionPreference={handleDiscussionPreference}
          />
        )}

        {stage === "loading" && <LoadingScreen />}

        {(stage === "results" || stage === "detail") && response && (
          <div className="max-w-7xl mx-auto px-6 py-8">

            {/* Page title */}
            <div className="mb-6 pb-4" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <h2 style={{ fontFamily: "'DM Serif Display', serif", color: "var(--text-primary)" }}
                className="text-2xl mb-1">
                {stage === "results" ? "Your Top 3 Schedules" : "Schedule Selected"}
              </h2>
              <p style={{ color: "var(--text-tertiary)" }} className="text-sm">
                {stage === "results"
                  ? "Compare your options below and select one to view full details."
                  : "Scroll down to view details, swap GE courses, or export to calendar."}
              </p>
            </div>

            {/* Schedule image cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
              {response.schedules.map((sched) => (
                <ScheduleImageCard
                  key={sched.rank}
                  schedule={sched}
                  label={["A", "B", "C"][sched.rank - 1]}
                  isSelected={selectedSchedule?.rank === sched.rank}
                  dimmed={stage === "detail" && selectedSchedule?.rank !== sched.rank}
                  onSelect={handleSelect}
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
      </main>

      {/* ── Footer ── */}
      <footer className="mt-16 py-6 text-center" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <p style={{ color: "var(--text-tertiary)" }} className="text-xs">
          Trojan Scheduler · Built for USC students · Not affiliated with USC
        </p>
      </footer>
    </div>
  )
}
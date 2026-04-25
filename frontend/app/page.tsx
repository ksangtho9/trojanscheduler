// Single-page app — manages state transitions:
// "form" -> "loading" -> "results" (image selection) -> "detail" (post-selection)
"use client"

import { useState } from "react"
import InputForm from "@/components/InputForm"
import LoadingScreen from "@/components/LoadingScreen"
import ScheduleImageCard from "@/components/ScheduleImageCard"
import ScheduleDetail from "@/components/ScheduleDetail"
import {
  AppStage,
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

      // Backend needs discussion time preference before solving
      if (data.needs_discussion_prompt) {
        setDiscussionPromptCourse(data.needs_discussion_prompt)
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
      discussion_preferences: pref as Record<string, DiscussionTimePref>,
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
    <div className="min-h-screen bg-[#080808] text-white">

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#080808]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#990000] flex items-center justify-center shadow-lg shadow-[#990000]/30">
              <span className="text-white font-black text-xs">TS</span>
            </div>
            <span className="font-semibold tracking-tight">Trojan Scheduler</span>
          </div>
          <span className="text-white/25 text-xs font-mono tracking-wider">
            USC · FALL 2025
          </span>
        </div>
      </nav>

      {/* Stage: Form */}
      {stage === "form" && (
        <InputForm
          onSubmit={handleSubmit}
          error={error}
          discussionPromptCourse={discussionPromptCourse}
          onDiscussionPreference={handleDiscussionPreference}
        />
      )}

      {/* Stage: Loading */}
      {stage === "loading" && <LoadingScreen />}

      {/* Stage: Results + Detail */}
      {(stage === "results" || stage === "detail") && response && (
        <div className="max-w-7xl mx-auto px-5 py-10">

          {/* Section header */}
          <div className="mb-8">
            <p className="text-[#990000] text-xs font-mono tracking-widest uppercase mb-1">
              {stage === "results" ? "Step 3 of 3" : "Selected"}
            </p>
            <h2 className="text-2xl font-bold tracking-tight">
              {stage === "results" ? "Your Top 3 Schedules" : "Schedule Selected"}
            </h2>
            <p className="text-white/35 text-sm mt-1">
              {stage === "results"
                ? "Compare your options and select one to view full details."
                : "Scroll down to view details, swap GE courses, or export."}
            </p>
          </div>

          {/* Image cards — always visible in both results and detail stages */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
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

          {/* Detail section — appears after selection */}
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
  )
}
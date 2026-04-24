// Stage 2: loading screen
// Animated step-by-step progress list shown while POST /generate is in flight
// Steps are timed on the frontend — not driven by real server events
"use client"

import { useEffect, useState } from "react"

const STEPS = [
  { label: "Reading your courses", delay: 0 },
  { label: "Scraping USC Schedule of Classes", delay: 2500 },
  { label: "Fetching RateMyProfessor scores", delay: 6000 },
  { label: "Finding GE options that fit", delay: 10000 },
  { label: "Running schedule optimizer", delay: 14000 },
  { label: "Building your top 3 schedules", delay: 17000 },
]

export default function LoadingScreen() {
  const [activeStep, setActiveStep] = useState(0)
  const [completedSteps, setCompletedSteps] = useState<number[]>([])
  const [dots, setDots] = useState(".")

  // Step progression timers
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []

    STEPS.forEach((step, i) => {
      timers.push(setTimeout(() => setActiveStep(i), step.delay))
      if (i > 0) {
        timers.push(
          setTimeout(() => setCompletedSteps((p) => [...p, i - 1]), step.delay)
        )
      }
    })

    return () => timers.forEach(clearTimeout)
  }, [])

  // Animated dots for active step
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."))
    }, 400)
    return () => clearInterval(interval)
  }, [])

  const progress = Math.min(
    100,
    Math.round(
      ((completedSteps.length + 0.5) / STEPS.length) * 100
    )
  )

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-6">

      {/* Spinner */}
      <div className="relative mb-10">
        <div className="w-20 h-20 rounded-full border-4 border-white/[0.06] border-t-[#990000] animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-10 h-10 rounded-xl bg-[#990000]/15 border border-[#990000]/25 flex items-center justify-center">
            <span className="text-white font-black text-xs">TS</span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-sm mb-8">
        <div className="flex justify-between text-xs text-white/30 mb-1.5">
          <span>Progress</span>
          <span className="font-mono text-[#990000]">{progress}%</span>
        </div>
        <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#990000] rounded-full transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Steps */}
      <div className="w-full max-w-sm space-y-3">
        {STEPS.map((step, i) => {
          const isDone = completedSteps.includes(i)
          const isActive = activeStep === i && !isDone
          const isPending = i > activeStep

          return (
            <div
              key={i}
              className={`flex items-center gap-3 transition-all duration-500 ${
                isPending ? "opacity-20" : "opacity-100"
              }`}
            >
              {/* Status icon */}
              <div className="w-5 h-5 shrink-0 flex items-center justify-center">
                {isDone ? (
                  <svg
                    viewBox="0 0 20 20"
                    className="w-5 h-5 text-emerald-400"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : isActive ? (
                  <div className="w-3 h-3 rounded-full bg-[#990000] animate-pulse" />
                ) : (
                  <div className="w-3 h-3 rounded-full border border-white/20" />
                )}
              </div>

              {/* Label */}
              <span
                className={`text-sm transition-colors ${
                  isDone
                    ? "text-white/35 line-through"
                    : isActive
                    ? "text-white font-medium"
                    : "text-white/30"
                }`}
              >
                {isActive ? `${step.label}${dots}` : step.label}
              </span>
            </div>
          )
        })}
      </div>

      <p className="mt-10 text-white/20 text-xs font-mono">
        Usually takes 15 – 30 seconds
      </p>
    </div>
  )
}
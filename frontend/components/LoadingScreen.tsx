"use client"
import { useCallback, useEffect, useState } from "react"
import { TextScramble } from "@/components/ui/text-scramble"

const STEPS = [
  { label: "Reading your courses", delay: 0 },
  { label: "Scraping USC Schedule of Classes", delay: 2500 },
  { label: "Fetching RateMyProfessor scores", delay: 6000 },
  { label: "Finding GE options that fit", delay: 10000 },
  { label: "Running schedule optimizer", delay: 14000 },
  { label: "Building your top 3 schedules", delay: 17000 },
]

const SCRAMBLE_CHUNK = `Resolving course section conflicts across time blocks. Enumerating valid lecture-discussion pairings. Cross-referencing department codes with USC Schedule of Classes. Applying constraint propagation to narrow feasible schedule space. Fetching professor quality scores from RateMyProfessor API. Scoring candidate schedules by convenience and professor rating. Filtering sections by modality preference and unit cap. Evaluating back-to-back penalties for morning and afternoon windows. Sorting GE candidates by category fulfillment weight. Pruning dominated schedules from the solution frontier. Serializing top results for client rendering.`

const SCRAMBLE_TEXT = Array(6).fill(SCRAMBLE_CHUNK).join("\n\n")

export default function LoadingScreen() {
  const [activeStep, setActiveStep] = useState(0)
  const [scrambleTrigger, setScrambleTrigger] = useState(true)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    STEPS.forEach((step, i) => {
      timers.push(setTimeout(() => setActiveStep(i), step.delay))
    })
    return () => timers.forEach(clearTimeout)
  }, [])

  const handleScrambleComplete = useCallback(() => {
    setScrambleTrigger(false)
    setTimeout(() => setScrambleTrigger(true), 4000)
  }, [])

  return (
    <div style={{ position: "relative", minHeight: "100vh", background: "white" }}>
      {/* Scramble text background */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
          overflow: "hidden",
          padding: "16px",
        }}
      >
        <TextScramble
          as="div"
          duration={12}
          speed={0.02}
          trigger={scrambleTrigger}
          onScrambleComplete={handleScrambleComplete}
          className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: "rgba(153, 0, 0, 0.09)" }}
        >
          {SCRAMBLE_TEXT}
        </TextScramble>
      </div>

      {/* Step label */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          gap: "8px",
        }}
      >
        <p className="text-sm font-medium" style={{ color: "var(--cardinal)" }}>
          {STEPS[activeStep].label}…
        </p>
        <p className="text-xs" style={{ color: "var(--text-muted, #9ca3af)" }}>
          Usually takes 15 – 30 seconds
        </p>
      </div>
    </div>
  )
}

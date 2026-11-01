"use client"
import { useEffect, useState } from "react"

const STEPS = [
  { label: "Reading your courses",                delay: 0 },
  { label: "Scraping USC Schedule of Classes",    delay: 600 },
  { label: "Fetching RateMyProfessor scores",     delay: 1400 },
  { label: "Finding GE options that fit",         delay: 2300 },
  { label: "Running schedule optimizer",          delay: 3200 },
  { label: "Building your top 3 schedules",       delay: 4000 },
]

// Progress % target when each step activates — matches step delays above.
// After the last step the bar creeps slowly toward 99 until the response arrives.
const STEP_TIMES = [0,  600, 1400, 2300, 3200, 4000]
const STEP_PCTS  = [5,  20,  38,   55,   72,   87  ]

// Probability a given loading block is rendered gold (vs cardinal). Kept low so
// the USC cardinal stays dominant while the mix is unique on every load.
const GOLD_PROBABILITY = 0.35

const DAYS = ["M", "T", "W", "Th", "F"]

type Block = {
  col: number
  row: number
  rowSpan: number
  accent: "cardinal" | "gold"
  delay: number
}

const BLOCKS: Block[] = [
  { col: 4, row: 1, rowSpan: 2, accent: "cardinal", delay: 650 },
  { col: 1, row: 3, rowSpan: 2, accent: "cardinal", delay: 750 },
  { col: 3, row: 3, rowSpan: 2, accent: "cardinal", delay: 850 },
  { col: 5, row: 3, rowSpan: 2, accent: "cardinal", delay: 950 },
  { col: 2, row: 5, rowSpan: 2, accent: "cardinal", delay: 1500 },
  { col: 4, row: 5, rowSpan: 2, accent: "cardinal", delay: 1600 },
  { col: 1, row: 7, rowSpan: 2, accent: "gold",     delay: 2400 },
  { col: 3, row: 7, rowSpan: 2, accent: "gold",     delay: 2500 },
]

type Accent = Block["accent"]

/** A fresh random accent per block. Called once per build so pauses keep the colors. */
export function randomLoadingAccents(): Accent[] {
  return BLOCKS.map(() => (Math.random() < GOLD_PROBABILITY ? "gold" : "cardinal"))
}

/** Progress % at a point on the scripted timeline. */
function progressAt(elapsed: number): number {
  const last = STEP_TIMES.length - 1
  if (elapsed >= STEP_TIMES[last]) {
    // After last step: creep from 87 → 99 over ~2s
    return Math.min(99, STEP_PCTS[last] + ((elapsed - STEP_TIMES[last]) / 2000) * 12)
  }
  // Interpolate between current and next step target
  let seg = 0
  for (let i = 0; i < last; i++) {
    if (elapsed >= STEP_TIMES[i] && elapsed < STEP_TIMES[i + 1]) {
      seg = i
      break
    }
  }
  const t = (elapsed - STEP_TIMES[seg]) / (STEP_TIMES[seg + 1] - STEP_TIMES[seg])
  return STEP_PCTS[seg] + t * (STEP_PCTS[seg + 1] - STEP_PCTS[seg])
}

const stepAt = (elapsed: number) => STEPS.reduce((acc, s, i) => (s.delay <= elapsed ? i : acc), 0)

/**
 * offsetMs resumes the scripted timeline instead of starting at 0. A build
 * that stops to ask for a lab/discussion time unmounts this screen; onPause
 * reports how far it got so the next round picks up there and the bar never
 * jumps backward.
 */
export default function LoadingScreen({
  offsetMs = 0,
  accents,
  onPause,
}: {
  offsetMs?: number
  accents?: Accent[]
  onPause?: (elapsedMs: number) => void
} = {}) {
  // Read once: later prop changes (auto-pick rounds) must not restart the clock
  const [startOffset] = useState(offsetMs)
  const [activeStep, setActiveStep] = useState(() => stepAt(startOffset))
  const [progress, setProgress] = useState(() => progressAt(startOffset))

  const [blocks] = useState(() => {
    const picked = accents ?? randomLoadingAccents()
    return BLOCKS.map((b, i) => ({ ...b, accent: picked[i] ?? b.accent }))
  })

  useEffect(() => {
    const timers = STEPS.filter((s) => s.delay > startOffset).map((s) =>
      setTimeout(() => setActiveStep(STEPS.indexOf(s)), s.delay - startOffset)
    )
    const start = Date.now() - startOffset
    const tick = setInterval(() => setProgress(progressAt(Date.now() - start)), 50)
    return () => {
      timers.forEach(clearTimeout)
      clearInterval(tick)
      onPause?.(Date.now() - start)
    }
  }, [startOffset, onPause])

  return (
    <div
      className="flex flex-col items-center justify-center px-6"
      style={{ minHeight: "100vh", paddingTop: "var(--topbar-height)" }}
    >
      <p
        className="text-2xl md:text-3xl text-center mb-10"
        style={{ fontFamily: "'DM Serif Display', serif", color: "var(--text-primary)" }}
      >
        Building your schedules
      </p>

      <div
        className="flex flex-col md:flex-row items-center md:items-start gap-8 w-full"
        style={{ maxWidth: 640 }}
      >
        {/* Mini schedule card */}
        <div
          className="card"
          style={{
            width: 280,
            padding: 16,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 6,
              marginBottom: 8,
            }}
          >
            {DAYS.map((d) => (
              <div
                key={d}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                  textAlign: "center",
                }}
              >
                {d}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gridTemplateRows: "repeat(8, 14px)",
              gap: 3,
              position: "relative",
            }}
          >
            {Array.from({ length: 40 }).map((_, i) => (
              <div
                key={i}
                style={{
                  background: "var(--bg-subtle)",
                  borderRadius: 2,
                }}
              />
            ))}
            {blocks.map((b, i) => (
              <div
                key={`block-${i}`}
                className="loading-schedule-block"
                style={{
                  gridColumn: b.col,
                  gridRow: `${b.row} / span ${b.rowSpan}`,
                  background:
                    b.accent === "gold" ? "var(--gold)" : "var(--cardinal)",
                  borderRadius: 3,
                  animationDelay: `${b.delay - startOffset}ms`, // negative = already shown
                }}
              />
            ))}
          </div>
        </div>

        {/* Step list */}
        <ul
          role="status"
          aria-live="polite"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            paddingTop: 24,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            flex: 1,
            minWidth: 0,
          }}
        >
          {STEPS.map((step, i) => {
            const state =
              i < activeStep ? "done" : i === activeStep ? "active" : "pending"
            return (
              <li
                key={i}
                className={`loading-step loading-step--${state}`}
              >
                <span className={`loading-step-bullet loading-step-bullet--${state}`}>
                  {state === "done" && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2 5.2L4.2 7.4L8.2 2.6"
                        stroke="var(--cardinal)"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                  {state === "active" && (
                    <span className="loading-step-bullet-dot" />
                  )}
                </span>
                <span className="loading-step-label">{step.label}</span>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Progress bar */}
      <div className="w-full" style={{ maxWidth: 640, marginTop: 24 }}>
        <div
          style={{
            height: 2,
            borderRadius: 1,
            background: "var(--border-default)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "100%",
              background:
                "linear-gradient(to right, var(--cardinal), var(--gold))",
              transform: `translateX(-${100 - progress}%)`,
              transition: "transform 200ms ease-out",
              willChange: "transform",
            }}
          />
        </div>
        <div
          className="flex justify-end items-center mt-2"
          style={{ color: "var(--text-tertiary)" }}
        >
          <span
            className="font-mono tabular-nums"
            style={{ fontSize: 12 }}
          >
            {Math.round(progress)}%
          </span>
        </div>
      </div>
    </div>
  )
}

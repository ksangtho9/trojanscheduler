"use client"

// First-visit onboarding: a welcome page (Start tour / Skip, no close button)
// that leads into a spotlight tour of the real form controls.
//
// Shown once per browser (localStorage). The "?" in the header replays the tour
// through `replayToken`. Tour steps find their targets by `data-tour="<id>"`,
// so the tour follows the real layout on any screen size; a step whose target
// isn't on the page is skipped.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { track } from "@/lib/analytics"

const STORAGE_KEY = "ts_onboarding_v1"

interface TourStep {
  target: string
  title: string
  body: string
}

const STEPS: TourStep[] = [
  {
    target: "term",
    title: "Pick your term",
    body: "Course lists and schedules are for the term shown here. It defaults to the next term you can register for.",
  },
  {
    target: "courses",
    title: "Add the classes you need",
    body: "Type a course code like WRIT 150, or choose a GE category. Classes you'd like but don't need go in Optional, just below.",
  },
  {
    target: "switches",
    title: "Two handy switches",
    body: "Auto Pick chooses labs and discussions for you. Planning Mode includes full sections, since waitlists often clear.",
  },
  {
    target: "limits",
    title: "Set your limits",
    body: "Tell us the earliest and latest you want class, how many units, and any days you want free.",
  },
  {
    target: "build",
    title: "Build and compare",
    body: "We rank your 3 best schedules by professor ratings and how well they fit your day. Pick one, swap sections, then add it to your calendar.",
  },
]

type Phase = "hidden" | "welcome" | "tour"

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function markSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, "seen")
  } catch {
    // private mode / storage disabled: the guide just shows again next visit
  }
}

// Read the "seen" flag as an external store: "server" during SSR (render
// nothing), the real value in the browser. Avoids a hydration mismatch.
function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange)
  return () => window.removeEventListener("storage", onChange)
}
function readSeen(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "unseen"
  } catch {
    return "unseen"
  }
}

function visibleTargets(id: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)).filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}

function unionRect(els: HTMLElement[], id?: string): Rect | null {
  if (!els.length) return null
  const rs = els.map((el) => el.getBoundingClientRect())
  const top = Math.min(...rs.map((r) => r.top))
  const left = Math.min(...rs.map((r) => r.left))
  let bottom = Math.max(...rs.map((r) => r.bottom))
  const right = Math.max(...rs.map((r) => r.right))
  // A step can end its highlight at a child marked data-tour-end, so a long
  // section highlights only what the step talks about (whole rows, never sliced).
  const end = id ? document.querySelector<HTMLElement>(`[data-tour-end="${id}"]`) : null
  if (end) {
    const r = end.getBoundingClientRect()
    if (r.height > 0) bottom = Math.min(bottom, r.bottom)
  }
  return { top, left, width: right - left, height: bottom - top }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export default function Onboarding({ replayToken }: { replayToken: number }) {
  const stored = useSyncExternalStore(subscribeStorage, readSeen, () => "server")
  // null = no decision yet this visit: follow the stored flag
  const [chosen, setChosen] = useState<Phase | null>(null)
  const [step, setStep] = useState(0)

  // "?" in the header replays the tour directly (state adjusted during render,
  // the React-recommended alternative to syncing props in an effect).
  const [handledReplay, setHandledReplay] = useState(replayToken)
  if (replayToken !== handledReplay) {
    setHandledReplay(replayToken)
    setStep(0)
    setChosen("tour")
  }

  const phase: Phase = chosen ?? (stored === "unseen" ? "welcome" : "hidden")

  // First visit: record that the welcome page was shown (once per mount)
  const shownLogged = useRef(false)
  useEffect(() => {
    if (phase === "welcome" && !shownLogged.current) {
      shownLogged.current = true
      track("onboarding_shown", {})
    }
  }, [phase])

  const startTour = () => {
    setStep(0)
    setChosen("tour")
    track("onboarding_tour_started", { source: "welcome" })
  }

  const skipWelcome = () => {
    markSeen()
    setChosen("hidden")
    track("onboarding_skipped", { at: "welcome" })
  }

  const skipTour = useCallback(() => {
    markSeen()
    setChosen("hidden")
    track("onboarding_skipped", { at: `step_${step + 1}` })
  }, [step])

  const finish = useCallback(() => {
    markSeen()
    setChosen("hidden")
    track("onboarding_completed", {})
  }, [])

  if (phase === "hidden") return null
  return createPortal(
    phase === "welcome" ? (
      <Welcome onStart={startTour} onSkip={skipWelcome} />
    ) : (
      <Tour step={step} setStep={setStep} onSkip={skipTour} onFinish={finish} />
    ),
    document.body,
  )
}

// ── Welcome page ──────────────────────────────────────────────────────────────

function Welcome({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  const startRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    startRef.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip()
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onSkip])

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15,8,8,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-body"
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--bg-card)",
          borderRadius: 22,
          padding: 24,
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--cardinal)" }}>
          Welcome
        </p>
        <h2
          id="onboarding-title"
          style={{ margin: "6px 0 8px", fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 28, lineHeight: 1.12, color: "var(--text-primary)" }}
        >
          Your best USC schedule, in seconds.
        </h2>
        <p id="onboarding-body" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--text-secondary)" }}>
          Tell us the classes you need. We search the section combinations and hand you the 3 best schedules, with professor ratings built in.
        </p>

        <WelcomeArt />

        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={onSkip}
            style={{ flex: 1, padding: "14px 16px", borderRadius: 12, border: "none", background: "var(--bg-page)", color: "var(--text-primary)", fontWeight: 600, fontSize: 14.5, cursor: "pointer" }}
          >
            Skip
          </button>
          <button
            ref={startRef}
            type="button"
            onClick={onStart}
            style={{ flex: 1, padding: "14px 16px", borderRadius: 12, border: "none", background: "var(--cardinal)", color: "#fff", fontWeight: 600, fontSize: 14.5, cursor: "pointer" }}
          >
            Start tour
          </button>
        </div>
        <p style={{ margin: "12px 0 0", textAlign: "center", fontSize: 12.5, color: "var(--text-tertiary)" }}>
          5 quick steps · replay any time with ?
        </p>
      </div>
    </div>
  )
}

// A tiny stylised week, matching the real grid's palette.
function WelcomeArt() {
  const blocks = [
    { col: 0, top: 26, h: 46, c: "#A30019" },
    { col: 1, top: 26, h: 46, c: "#047857" },
    { col: 2, top: 26, h: 46, c: "#A30019" },
    { col: 3, top: 8, h: 26, c: "#3730A3" },
    { col: 3, top: 98, h: 40, c: "#A30019" },
    { col: 4, top: 70, h: 26, c: "#3730A3" },
    { col: 0, top: 112, h: 34, c: "#047857" },
  ]
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        height: 172,
        margin: "18px 0",
        borderRadius: 16,
        background: "linear-gradient(160deg, #FFF7E0, #FFFFFF)",
        border: "1px solid #F2E6C4",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", inset: "14px 18px", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
        {[0, 1, 2, 3, 4].map((col) => (
          <div key={col} style={{ position: "relative" }}>
            {blocks
              .filter((b) => b.col === col)
              .map((b, i) => (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: b.top, height: b.h, borderRadius: 6, background: b.c }} />
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Spotlight tour ────────────────────────────────────────────────────────────

const PAD = 6 // space between the target and the spotlight edge
const TIP_GAP = 14

function Tour({
  step,
  setStep,
  onSkip,
  onFinish,
}: {
  step: number
  setStep: (n: number) => void
  onSkip: () => void
  onFinish: () => void
}) {
  const [rect, setRect] = useState<Rect | null>(null)
  const [tipH, setTipH] = useState(190)
  const tipRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const isLast = step === STEPS.length - 1
  const current = STEPS[step]

  const go = useCallback(
    (dir: 1 | -1) => {
      // Move to the next step whose target is on the page; finish past the end.
      let n = step + dir
      while (n >= 0 && n < STEPS.length && visibleTargets(STEPS[n].target).length === 0) n += dir
      if (n >= STEPS.length) onFinish()
      else if (n >= 0) setStep(n)
    },
    [step, setStep, onFinish],
  )

  // Bring the target into view, then keep the spotlight glued to it.
  useLayoutEffect(() => {
    const els = visibleTargets(current.target)
    if (!els.length) {
      go(1)
      return
    }
    const first = els[0]
    const r = unionRect(els, current.target)!
    const isFixed = getComputedStyle(first).position === "fixed" || first.closest(".app-submit-footer") !== null
    if (!isFixed) {
      const topbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-height")) || 0
      const tall = r.height > window.innerHeight * 0.45
      const target = tall
        ? window.scrollY + r.top - topbar - 24
        : window.scrollY + r.top - (window.innerHeight - r.height) / 2
      window.scrollTo({ top: Math.max(0, target), behavior: "auto" })
    }
    const update = () => setRect(unionRect(visibleTargets(current.target), current.target))
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, { passive: true })
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update)
    }
  }, [current.target, go])

  useLayoutEffect(() => {
    if (tipRef.current) setTipH(tipRef.current.getBoundingClientRect().height)
    nextRef.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
  }, [step, rect?.width])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip()
      else if (e.key === "ArrowRight") go(1)
      else if (e.key === "ArrowLeft") go(-1)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [go, onSkip])

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024
  const vh = typeof window !== "undefined" ? window.innerHeight : 768
  const motion = prefersReducedMotion() ? "none" : "top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease"

  // Spotlight box, clipped to the viewport.
  const tipW = Math.min(340, vw - 32)
  const spotTop = rect ? Math.max(rect.top - PAD, 8) : 0
  const fullHeight = rect ? Math.min(rect.top + rect.height + PAD, vh - 8) - spotTop : 0

  // Tooltip: below the target if it fits, else above. A target too tall for
  // either (e.g. the limits section on a phone) gets its spotlight shortened
  // so the tooltip sits below it instead of covering it.
  let spotHeight = fullHeight
  let tipTop = vh - tipH - 16
  let arrow: "up" | "down" | null = null
  if (rect) {
    const below = spotTop + fullHeight + TIP_GAP
    const above = spotTop - TIP_GAP - tipH
    if (below + tipH <= vh - 12) {
      tipTop = below
      arrow = "up"
    } else if (above >= 12) {
      tipTop = above
      arrow = "down"
    } else {
      spotHeight = Math.max(vh - 16 - tipH - TIP_GAP - spotTop, 60)
      tipTop = spotTop + spotHeight + TIP_GAP
      arrow = "up"
    }
  }
  const spot = rect && {
    top: spotTop,
    left: Math.max(rect.left - PAD, 8),
    width: Math.min(rect.width + PAD * 2, vw - 16),
    height: spotHeight,
  }
  const tipLeft = spot ? Math.min(Math.max(spot.left, 16), vw - tipW - 16) : (vw - tipW) / 2
  const arrowLeft = spot ? Math.min(Math.max(spot.left + Math.min(spot.width, tipW) / 2 - tipLeft, 18), tipW - 30) : 0

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
      {/* Click shield: the page underneath stays put during the tour */}
      <div style={{ position: "absolute", inset: 0 }} />

      {spot && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            ...spot,
            borderRadius: 14,
            boxShadow: "0 0 0 9999px rgba(15,8,8,0.62)",
            outline: "2px solid var(--gold)",
            outlineOffset: 2,
            transition: motion,
            pointerEvents: "none",
          }}
        />
      )}

      <div
        ref={tipRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={{
          position: "fixed",
          top: tipTop,
          left: tipLeft,
          width: tipW,
          background: "var(--bg-card)",
          borderRadius: 16,
          padding: "16px 16px 14px",
          boxShadow: "0 16px 40px rgba(0,0,0,0.35)",
          fontFamily: "Inter, sans-serif",
          transition: motion === "none" ? "none" : "top 0.25s ease, left 0.25s ease",
        }}
      >
        {arrow && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: arrowLeft,
              [arrow === "up" ? "top" : "bottom"]: -7,
              width: 14,
              height: 14,
              background: "var(--bg-card)",
              transform: "rotate(45deg)",
            }}
          />
        )}
        <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--cardinal)" }}>
          {step + 1} of {STEPS.length}
        </p>
        <h3 id="tour-title" style={{ margin: "4px 0", fontSize: 15.5, fontWeight: 700, color: "var(--text-primary)" }}>
          {current.title}
        </h3>
        <p id="tour-body" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
          {current.body}
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
          <button
            type="button"
            onClick={onSkip}
            style={{ background: "none", border: "none", padding: "8px 4px", fontSize: 13, color: "var(--text-tertiary)", cursor: "pointer" }}
          >
            Skip tour
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button
                type="button"
                onClick={() => go(-1)}
                style={{ padding: "9px 14px", borderRadius: 10, border: "none", background: "var(--bg-page)", color: "var(--text-primary)", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
              >
                Back
              </button>
            )}
            <button
              ref={nextRef}
              type="button"
              onClick={() => (isLast ? onFinish() : go(1))}
              style={{ padding: "9px 16px", borderRadius: 10, border: "none", background: "var(--cardinal)", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
            >
              {isLast ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

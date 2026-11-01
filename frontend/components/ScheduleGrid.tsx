// CSS/HTML schedule renderer. Two density modes:
//   compact — small thumbnails in the result cards
//   large   — full-bleed schedule visible on the detail page
"use client"

import { useEffect, useRef, useState } from "react"
import { Schedule, CourseEntry, LinkedSection } from "@/lib/types"
import { clockMinutes, formatClock, formatClockRange } from "@/lib/time"
import { COURSE_PALETTE, GE_COLOR, assignCourseColors } from "@/lib/courseColors"

interface Props {
  schedule: Schedule
  size?: "compact" | "large"
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const
const START_MIN = 8 * 60   // 8:00
const END_MIN = 20 * 60    // 20:00
const SPAN = END_MIN - START_MIN

const DOUBLE_COUNT_BG = "#F0B400"   // USC gold for stacked-GE specials
const DOUBLE_COUNT_FG = "#1A1A00"

// GE and double-count blocks use their own dedicated colors, so they are left out.
function buildColorMap(schedule: Schedule): Map<string, string> {
  return assignCourseColors(
    schedule.courses.filter((c) => c.entry_type !== "ge" && !c.is_double_count).map((c) => c.course),
  )
}

function pos(t: string): number {
  const total = clockMinutes(t) ?? START_MIN
  return Math.max(0, Math.min(1, (total - START_MIN) / SPAN))
}

// Full-word time formatting: "8am", "12pm", "1:30pm".
const fmt = (t: string) => formatClock(t)

// Format an instructor name as "Last, First". "Karen S. Reeves" -> "Reeves, Karen S."
// Falls through TBA / single-word names unchanged.
function nameLastFirst(prof: string): string {
  if (!prof || prof === "TBA") return prof || "TBA"
  const parts = prof.trim().split(/\s+/)
  if (parts.length === 1) return parts[0]
  const last = parts[parts.length - 1]
  const first = parts.slice(0, -1).join(" ")
  return `${last}, ${first}`
}

// Capitalize "discussion" -> "Discussion", "lab" -> "Lab".
/** True when a section has days and a clock time, i.e. it can be drawn. */
function isTimed(days: string[], start: string, end: string): boolean {
  return days.length > 0 && clockMinutes(start) !== null && clockMinutes(end) !== null
}

function titleCase(s: string): string {
  if (!s) return ""
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export default function ScheduleGrid({ schedule, size = "compact" }: Props) {
  const isLarge = size === "large"

  // Per-schedule color assignment — guarantees distinct colors per course.
  const colorMap = buildColorMap(schedule)

  // The detail ("large") grid is full-bleed on desktop but phone-width on
  // mobile; there its 72px time gutter left ~42px per day. Slim it down.
  const rootRef = useRef<HTMLDivElement>(null)
  const [rootWidth, setRootWidth] = useState<number | null>(null)
  const roomy = isLarge && (rootWidth === null || rootWidth >= 560)

  // Density-dependent dimensions
  const dayHeaderSize = isLarge ? 11 : 9
  const dayHeaderPad = isLarge ? "12px 0 10px" : "7px 0 6px"
  const timeGutterWidth = roomy ? 72 : 44
  const timeFontSize = isLarge ? 11 : 9
  const blockRadius = isLarge ? 7 : 4
  const dayGap = roomy ? 6 : isLarge ? 4 : 2

  // Measure the real column size so blocks decide what text fits in pixels,
  // not percentages. The same 50-minute class is ~12px tall in a phone card and
  // ~50px in the detail view, so percentage thresholds clipped text mid-glyph.
  const columnsRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<GridMetrics | null>(null)
  useEffect(() => {
    const el = columnsRef.current
    if (!el) return
    const update = () => {
      const { width, height } = el.getBoundingClientRect()
      setMetrics({ height, colWidth: (width - dayGap * (DAYS.length - 1)) / DAYS.length })
      if (rootRef.current) setRootWidth(rootRef.current.getBoundingClientRect().width)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (rootRef.current) ro.observe(rootRef.current)
    return () => ro.disconnect()
  }, [dayGap])

  const untimed: string[] = []
  for (const course of schedule.courses) {
    if (!isTimed(course.days, course.start_time, course.end_time)) untimed.push(course.course)
    for (const ls of course.linked_sections) {
      if (ls && !isTimed(ls.days, ls.start_time, ls.end_time)) untimed.push(`${course.course} ${titleCase(ls.section_type)}`)
    }
  }

  // Every hour from 8am through 8pm, in both modes.
  const hours: number[] = []
  for (let h = 8; h <= 20; h += 1) hours.push(h)

  return (
    <div
      ref={rootRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-card)",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {/* Day headers */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ width: timeGutterWidth, flexShrink: 0 }} />
        {DAYS.map((day) => {
          const isOn = schedule.days_with_class.includes(day)
          return (
            <div
              key={day}
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: dayHeaderSize,
                fontWeight: 700,
                letterSpacing: "0.10em",
                padding: dayHeaderPad,
                color: isOn ? "var(--text-primary)" : "var(--text-tertiary)",
                opacity: isOn ? 1 : 0.5,
                textTransform: "uppercase",
              }}
            >
              {isLarge ? day.toUpperCase() : day[0]}
            </div>
          )
        })}
      </div>

      {/* Grid body */}
      <div
        style={{
          display: "flex",
          flex: 1,
          position: "relative",
          padding: roomy ? "10px 8px" : isLarge ? "8px 4px" : "4px 4px",
        }}
      >
        {/* Time gutter — every hour */}
        <div style={{ width: timeGutterWidth, flexShrink: 0, position: "relative" }}>
          {hours.map((h) => {
            const top = ((h * 60 - START_MIN) / SPAN) * 100
            const ampm = h >= 12 ? "pm" : "am"
            const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
            return (
              <div
                key={h}
                style={{
                  position: "absolute",
                  right: 8,
                  top: `${top}%`,
                  transform: "translateY(-50%)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: timeFontSize,
                  color: "var(--text-tertiary)",
                  lineHeight: 1,
                  letterSpacing: "0.02em",
                }}
              >
                {`${hour}${ampm}`}
              </div>
            )
          })}
        </div>

        {/* Day columns + overlay gridlines */}
        <div ref={columnsRef} style={{ flex: 1, display: "flex", gap: dayGap, position: "relative" }}>
          {/* Hour gridlines — every hour, span all columns */}
          {hours.slice(1, -1).map((h) => {
            const top = ((h * 60 - START_MIN) / SPAN) * 100
            return (
              <div
                key={h}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${top}%`,
                  height: 1,
                  background: "var(--border-subtle)",
                  // every other hour gets a stronger line for readability
                  opacity: h % 2 === 0 ? 0.7 : 0.35,
                  pointerEvents: "none",
                }}
              />
            )
          })}

          {DAYS.map((day) => {
            const isOn = schedule.days_with_class.includes(day)
            return (
              <div
                key={day}
                style={{
                  flex: 1,
                  position: "relative",
                  background: isOn ? "transparent" : "rgba(0,0,0,0.018)",
                  borderRadius: isLarge ? 8 : 4,
                }}
              >
                {/* Lecture blocks */}
                {schedule.courses.map((course) => {
                  if (!course.days.includes(day)) return null
                  return (
                    <CourseBlock
                      key={course.section_id}
                      course={course}
                      color={colorMap.get(course.course) ?? COURSE_PALETTE[0]}
                      isLarge={isLarge}
                      radius={blockRadius}
                      metrics={metrics}
                    />
                  )
                })}

                {/* Linked sections (discussion / lab / quiz) */}
                {schedule.courses.flatMap((course) =>
                  course.linked_sections
                    .filter((ls) => ls.days.includes(day))
                    .map((ls) => (
                      <LinkedBlock
                        key={`${course.section_id}-${ls.section_id}`}
                        course={course}
                        section={ls}
                        color={colorMap.get(course.course) ?? COURSE_PALETTE[0]}
                        isLarge={isLarge}
                        radius={blockRadius}
                        metrics={metrics}
                      />
                    ))
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Sections with no fixed meeting time can't be drawn; say so instead of
          letting them vanish (a TBA lecture used to show as just its lab). */}
      {untimed.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--border-subtle)",
            padding: isLarge ? "8px 12px" : "5px 8px",
            fontSize: isLarge ? 12 : 10,
            lineHeight: 1.35,
            color: "var(--text-tertiary)",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>No set time, not shown: </span>
          {untimed.join(" · ")}
        </div>
      )}
    </div>
  )
}

// ── Block layout ──────────────────────────────────────────────────────────────

interface GridMetrics {
  /** Day-column height in px (the 8am-8pm span) */
  height: number
  /** Width of one day column in px */
  colWidth: number
}

interface Line {
  text: string
  size: number
  weight: number
  mono?: boolean
  faded?: boolean
}

// Columns narrower than this can't fit "PHYS 152 Lab" on one line, so the code
// stacks as "PHYS" / "152 Lab" instead of being cut to "P…".
const NARROW_COL_PX = 96

const SHORT_TYPE: Record<string, string> = { discussion: "Dis", laboratory: "Lab", lab: "Lab", quiz: "Quiz", lecture: "" }

function shortType(type: string): string {
  const key = type.toLowerCase()
  return SHORT_TYPE[key] ?? titleCase(type).slice(0, 4)
}

/**
 * Decide which lines a block shows. Only whole lines that fit inside the block
 * are rendered, so text is never sliced through the middle of a glyph.
 */
function layoutBlock({
  code,
  type,
  prof,
  start,
  end,
  heightPx,
  colWidth,
  isLarge,
}: {
  code: string
  type?: string
  prof?: string
  start: string
  end: string
  heightPx: number | null
  colWidth: number | null
  isLarge: boolean
}): { lines: Line[]; padY: number; padX: number; gap: number } {
  const narrow = colWidth !== null && colWidth < NARROW_COL_PX
  const main = isLarge ? (narrow ? 11.5 : 15) : narrow ? 10 : 11.5
  const sub = isLarge ? (narrow ? 10 : 12) : narrow ? 9 : 10
  const padX = narrow ? 4 : isLarge ? 12 : 8
  const padY = heightPx !== null && heightPx < 26 ? 2 : isLarge ? 8 : 4
  const gap = isLarge ? 2 : 1

  const candidates: Line[] = []
  if (narrow) {
    const [dept, ...rest] = code.split(" ")
    const number = rest.join(" ")
    const t = type ? shortType(type) : ""
    const oneLine = [code, t].filter(Boolean).join(" ")
    // ~0.62em per glyph for Inter bold; keep one line when it fits the width
    const fitsOneLine = colWidth !== null && oneLine.length * main * 0.62 <= colWidth - padX * 2 - 4
    const roomForTwo = heightPx === null || heightPx >= padY * 2 + Math.ceil(main * 1.2) * 2 + gap
    if (fitsOneLine) {
      candidates.push({ text: oneLine, size: main, weight: 700 })
    } else if (!roomForTwo) {
      // One short line and the full code is too wide: "MATH" reads better than
      // "MAT…". Color + the tooltip identify the exact course.
      candidates.push({ text: dept, size: main, weight: 700 })
    } else {
      candidates.push({ text: dept, size: main, weight: 700 })
      if (number || t) candidates.push({ text: [number, t].filter(Boolean).join(" "), size: main, weight: 700 })
    }
    candidates.push({ text: formatClock(start), size: sub, weight: 500, mono: true, faded: true })
  } else {
    candidates.push({ text: type ? `${code} ${titleCase(type)}` : code, size: main, weight: 700 })
    if (prof) candidates.push({ text: prof, size: sub, weight: 500, faded: true })
    candidates.push({ text: `${fmt(start)} - ${fmt(end)}`, size: sub, weight: 500, mono: true, faded: true })
  }

  // Before the first measurement, show just the first line rather than guess.
  if (heightPx === null) return { lines: candidates.slice(0, 1), padY, padX, gap }

  const lines: Line[] = []
  let used = padY * 2
  for (const line of candidates) {
    const lineH = Math.ceil(line.size * 1.2) + (lines.length ? gap : 0)
    if (used + lineH > heightPx) break
    lines.push(line)
    used += lineH
  }
  return { lines, padY, padX, gap }
}

function BlockBody({ lines, fg, fgFaded, gap }: { lines: Line[]; fg: string; fgFaded: string; gap: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap, minWidth: 0 }}>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            fontSize: line.size,
            fontWeight: line.weight,
            fontFamily: line.mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
            color: line.faded ? fgFaded : fg,
            letterSpacing: line.mono ? 0 : "0.02em",
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {line.text}
        </div>
      ))}
    </div>
  )
}

// ── Course block ──────────────────────────────────────────────────────────────

function CourseBlock({
  course,
  color,
  isLarge,
  radius,
  metrics,
}: {
  course: CourseEntry
  color: string
  isLarge: boolean
  radius: number
  metrics: GridMetrics | null
}) {
  const top = pos(course.start_time)
  const heightPct = Math.max(pos(course.end_time) - top, isLarge ? 0.05 : 0.04)
  const isGE = course.entry_type === "ge"
  const isDC = course.is_double_count
  const bg = isDC ? DOUBLE_COUNT_BG : isGE ? GE_COLOR : color
  const fg = isDC ? DOUBLE_COUNT_FG : "#ffffff"
  const fgFaded = isDC ? "rgba(26,26,0,0.65)" : "rgba(255,255,255,0.82)"

  const prof = course.professor && course.professor !== "TBA" ? nameLastFirst(course.professor) : ""
  const { lines, padY, padX, gap } = layoutBlock({
    code: course.course,
    prof,
    start: course.start_time,
    end: course.end_time,
    heightPx: metrics ? heightPct * metrics.height : null,
    colWidth: metrics?.colWidth ?? null,
    isLarge,
  })

  return (
    <div
      title={`${course.course}${course.topic ? ` · ${course.topic}` : ""} · ${formatClockRange(course.start_time, course.end_time, " - ")}${prof ? ` · ${prof}` : ""}`}
      style={{
        position: "absolute",
        left: 2,
        right: 2,
        top: `${top * 100}%`,
        height: `${heightPct * 100}%`,
        background: bg,
        color: fg,
        borderRadius: radius,
        padding: `${padY}px ${padX}px`,
        overflow: "hidden",
        boxShadow: isDC
          ? "0 1px 0 rgba(0,0,0,0.15) inset, 0 2px 6px rgba(240,180,0,0.25)"
          : "0 1px 0 rgba(0,0,0,0.15) inset, 0 2px 4px rgba(0,0,0,0.08)",
      }}
    >
      <BlockBody lines={lines} fg={fg} fgFaded={fgFaded} gap={gap} />
    </div>
  )
}

// ── Linked section (discussion / lab / quiz) ──────────────────────────────────

function LinkedBlock({
  course,
  section,
  color,
  isLarge,
  radius,
  metrics,
}: {
  course: CourseEntry
  section: LinkedSection
  color: string
  isLarge: boolean
  radius: number
  metrics: GridMetrics | null
}) {
  const top = pos(section.start_time)
  const heightPct = Math.max(pos(section.end_time) - top, isLarge ? 0.04 : 0.03)

  // Full color matching the parent lecture, so discussions / labs / quizzes
  // read as siblings of the lecture. The type label tells them apart.
  const fg = "#ffffff"
  const fgFaded = "rgba(255,255,255,0.82)"
  const { lines, padY, padX, gap } = layoutBlock({
    code: course.course,
    type: section.section_type,
    start: section.start_time,
    end: section.end_time,
    heightPx: metrics ? heightPct * metrics.height : null,
    colWidth: metrics?.colWidth ?? null,
    isLarge,
  })

  return (
    <div
      title={`${course.course} ${titleCase(section.section_type)} · ${formatClockRange(section.start_time, section.end_time, " - ")}`}
      style={{
        position: "absolute",
        left: 2,
        right: 2,
        top: `${top * 100}%`,
        height: `${heightPct * 100}%`,
        background: color,
        color: fg,
        borderRadius: radius,
        padding: `${padY}px ${padX}px`,
        overflow: "hidden",
        boxShadow: "0 1px 0 rgba(0,0,0,0.15) inset, 0 2px 4px rgba(0,0,0,0.08)",
      }}
    >
      <BlockBody lines={lines} fg={fg} fgFaded={fgFaded} gap={gap} />
    </div>
  )
}

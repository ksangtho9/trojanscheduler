// Stage 4: post-selection detail view.
// Large schedule grid + polished course list + summary + actions.
"use client"

import { useState, useMemo } from "react"
import { CourseEntry, RunnerUp, Schedule, SwapState } from "@/lib/types"
import { generateICS } from "@/lib/icsExport"
import { track } from "@/lib/analytics"
import ScheduleGrid from "./ScheduleGrid"
import { formatClock, formatClockRange } from "@/lib/time"

interface Props {
  schedule: Schedule
  swapState: SwapState
  onSwap: (originalId: string, replacement: CourseEntry) => void
  onStartOver: () => void
  /** Term the schedule was built for; sets the .ics date range */
  termCode?: string
  termLabel?: string
}

export default function ScheduleDetail({
  schedule,
  swapState,
  onSwap,
  onStartOver,
  termCode,
  termLabel,
}: Props) {
  const [expandedSwap, setExpandedSwap] = useState<string | null>(null)

  const resolvedCourses = schedule.courses.map((course) =>
    swapState[course.section_id] ?? course
  )

  const previewSchedule: Schedule = useMemo(
    () => ({ ...schedule, courses: resolvedCourses }),
    [schedule, resolvedCourses]
  )

  const handleExport = () => {
    let icsString: string
    try {
      icsString = generateICS(schedule, resolvedCourses, termCode, termLabel)
    } catch {
      alert("Calendar export isn't available for this term yet.")
      return
    }
    track("schedule_exported", { term_code: termCode, rank: schedule.rank, course_count: resolvedCourses.length })
    const blob = new Blob([icsString], { type: "text/calendar" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    const termSlug = termLabel ? `-${termLabel.toLowerCase().replace(/\s+/g, "-")}` : ""
    a.download = `trojan-schedule${termSlug}.ics`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 40, paddingTop: 32 }}>

      {/* Section header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 20, paddingBottom: 12, borderBottom: "1px solid var(--border-subtle)" }}>
        <div>
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--cardinal)",
              marginBottom: 12,
            }}
          >
            Step 03 / Review &amp; Export
          </p>
          <h3
            style={{
              fontFamily: "'DM Serif Display', serif",
              color: "var(--text-primary)",
              fontSize: 36,
              lineHeight: 1.05,
              letterSpacing: "-0.01em",
              marginBottom: 10,
            }}
          >
            Your selection.
          </h3>
          <p style={{ color: "var(--text-tertiary)", fontSize: 14, lineHeight: 1.5, maxWidth: 520 }}>
            {resolvedCourses.length} courses, {schedule.total_units} units. Swap GE alternatives below, then export to your calendar.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <SecondaryButton onClick={handleExport} label="Export .ics" />
          <PrimaryButton onClick={onStartOver} label="Start over" />
        </div>
      </div>

      {/* Large schedule grid */}
      <div
        style={{
          borderRadius: 18,
          overflow: "hidden",
          background: "var(--bg-card)",
          border: "1px solid var(--border-subtle)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          height: 680,
        }}
      >
        <ScheduleGrid schedule={previewSchedule} size="large" />
      </div>

      {/* Course list */}
      <div>
        <p
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: 16,
          }}
        >
          Courses
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {resolvedCourses.map((course) => (
            <CourseRow
              key={course.section_id}
              course={course}
              isSwapOpen={expandedSwap === course.section_id}
              onToggleSwap={() =>
                setExpandedSwap(
                  expandedSwap === course.section_id ? null : course.section_id
                )
              }
              onSwap={(runner) => {
                const replacement: CourseEntry = {
                  ...course,
                  course: runner.course,
                  section_id: runner.section_id,
                  professor: runner.professor,
                  rmp_score: runner.rmp_score,
                  rmp_difficulty: null,
                  would_take_again: null,
                  rmp_total_ratings: 0,
                  rmp_profile_url: null,
                  no_rmp_data: false,
                  days: runner.days,
                  start_time: runner.start_time,
                  end_time: runner.end_time,
                  seats_available: runner.seats_available,
                  total_seats: runner.total_seats,
                  seat_color: "#FFFFFF",
                  linked_sections: runner.linked_sections,
                  runner_ups: null,
                }
                onSwap(course.section_id, replacement)
                setExpandedSwap(null)
              }}
            />
          ))}
        </div>
      </div>

      {/* Summary footer */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 18,
          padding: 28,
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <p
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: 16,
          }}
        >
          Schedule Summary
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          <SummaryCell label="Total Units" value={String(schedule.total_units)} />
          <SummaryCell label="Avg RMP" value={schedule.avg_rmp.toFixed(1)} />
          <SummaryCell
            label="Days on Campus"
            value={schedule.days_with_class.length.toString()}
          />
          <SummaryCell
            label="Total Gap Time"
            value={schedule.gap_minutes > 0 ? `${schedule.gap_minutes} min` : "None"}
          />
        </div>
      </div>
    </div>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────

function PrimaryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "12px 22px",
        borderRadius: 12,
        border: "none",
        background: "var(--text-primary)",
        color: "#ffffff",
        fontFamily: "'Inter', sans-serif",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--cardinal)" }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--text-primary)" }}
    >
      {label}
    </button>
  )
}

function SecondaryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "12px 22px",
        borderRadius: 12,
        border: "1.5px solid var(--border-default)",
        background: "var(--bg-card)",
        color: "var(--text-primary)",
        fontFamily: "'Inter', sans-serif",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        transition: "border-color 0.15s, background 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--cardinal)"
        e.currentTarget.style.background = "rgba(153,0,0,0.04)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-default)"
        e.currentTarget.style.background = "var(--bg-card)"
      }}
    >
      {label}
    </button>
  )
}

// ── Course row ────────────────────────────────────────────────────────────────

const formatTime = (t: string) => formatClock(t)

function formatDays(days: string[]): string {
  return days.join(" / ")
}

function titleCase(s: string): string {
  if (!s) return ""
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function CourseRow({
  course,
  isSwapOpen,
  onToggleSwap,
  onSwap,
}: {
  course: CourseEntry
  isSwapOpen: boolean
  onToggleSwap: () => void
  onSwap: (runner: RunnerUp) => void
}) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 18,
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ padding: 24 }}>
        {/* Course code + chips */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <span
            style={{
              fontFamily: "'DM Serif Display', serif",
              fontSize: 24,
              letterSpacing: "-0.01em",
              color: "var(--text-primary)",
              lineHeight: 1,
            }}
          >
            {course.course}
          </span>

          {course.entry_type === "ge" && course.ge_slot && (
            <Chip
              bg="rgba(194, 65, 12, 0.08)"
              fg="#9A3412"
              border="rgba(194, 65, 12, 0.30)"
            >
              {course.ge_slot}
            </Chip>
          )}

          {course.is_double_count && (
            <Chip
              bg="rgba(240, 180, 0, 0.14)"
              fg="#6B5200"
              border="rgba(240, 180, 0, 0.45)"
            >
              2x GE: {course.double_count_categories.join(" + ")}
            </Chip>
          )}

          <Chip
            bg="rgba(0,0,0,0.04)"
            fg="var(--text-tertiary)"
            border="var(--border-subtle)"
          >
            {titleCase(course.section_type)}
          </Chip>
        </div>

        {/* Professor + inline RMP link + inline seat status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 500, color: "var(--text-primary)" }}>
            {course.professor}
          </span>
          <RMPLink course={course} />
          <SeatIndicator course={course} />
        </div>

        {/* Meta strip */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", fontSize: 13, color: "var(--text-tertiary)" }}>
          <Meta label="Days" value={formatDays(course.days)} />
          <Meta label="Time" value={formatClockRange(course.start_time, course.end_time)} />
          <Meta label="Units" value={course.units.toString()} />
          <Meta label="Location" value={course.location || "TBA"} />
        </div>

        {course.linked_sections.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--border-subtle)", display: "flex", flexDirection: "column", gap: 6 }}>
            {course.linked_sections.map((ls) => (
              <div
                key={ls.section_id}
                style={{
                  display: "flex",
                  gap: 16,
                  flexWrap: "wrap",
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  alignItems: "baseline",
                }}
              >
                <span
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  {titleCase(ls.section_type)}
                </span>
                <span>{formatDays(ls.days)}</span>
                <span>{formatClockRange(ls.start_time, ls.end_time)}</span>
                {ls.location && <span>{ls.location}</span>}
              </div>
            ))}
          </div>
        )}

        {course.entry_type === "ge" && course.runner_ups && course.runner_ups.length > 0 && (
          <button
            onClick={onToggleSwap}
            style={{
              marginTop: 16,
              padding: 0,
              border: "none",
              background: "transparent",
              color: "var(--text-tertiary)",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.02em",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--cardinal)" }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)" }}
          >
            {isSwapOpen
              ? "Hide alternatives"
              : `Show ${course.runner_ups.length} alternative${course.runner_ups.length > 1 ? "s" : ""}`}
          </button>
        )}
      </div>

      {isSwapOpen && course.runner_ups && (
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--bg-subtle)",
            padding: "16px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              marginBottom: 10,
            }}
          >
            Alternatives for {course.ge_slot}
          </p>
          {course.runner_ups.map((runner) => (
            <RunnerUpRow
              key={runner.section_id}
              runner={runner}
              onSwap={() => onSwap(runner)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Chip({
  children,
  bg,
  fg,
  border,
}: {
  children: React.ReactNode
  bg: string
  fg: string
  border: string
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
        borderRadius: 999,
        padding: "3px 9px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </span>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--text-secondary)" }}>
        {value}
      </span>
    </span>
  )
}

function RMPLink({ course }: { course: CourseEntry }) {
  if (course.no_rmp_data) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 12,
          fontWeight: 600,
          padding: "5px 10px",
          borderRadius: 8,
          color: "var(--text-tertiary)",
          border: "1px solid var(--border-default)",
          background: "var(--bg-card)",
          letterSpacing: "0.02em",
        }}
      >
        No RMP ratings
      </span>
    )
  }

  const tier =
    course.rmp_score >= 4
      ? { fg: "#15803D", bg: "rgba(21,128,61,0.08)", border: "rgba(21,128,61,0.30)", hoverBg: "rgba(21,128,61,0.14)" }
      : course.rmp_score >= 3
      ? { fg: "#9A6700", bg: "rgba(154,103,0,0.08)", border: "rgba(154,103,0,0.30)", hoverBg: "rgba(154,103,0,0.14)" }
      : { fg: "#B91C1C", bg: "rgba(185,28,28,0.08)", border: "rgba(185,28,28,0.30)", hoverBg: "rgba(185,28,28,0.14)" }

  const href = course.rmp_profile_url ?? undefined
  const isLink = Boolean(href)

  return (
    <a
      href={href}
      target={isLink ? "_blank" : undefined}
      rel={isLink ? "noopener noreferrer" : undefined}
      title={isLink ? "Open Rate My Professors profile" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "'Inter', sans-serif",
        fontSize: 13,
        fontWeight: 600,
        padding: "5px 12px",
        borderRadius: 8,
        color: tier.fg,
        background: tier.bg,
        border: `1px solid ${tier.border}`,
        textDecoration: "none",
        letterSpacing: "0.01em",
        cursor: isLink ? "pointer" : "default",
        transition: "background 0.15s, border-color 0.15s",
        fontVariantNumeric: "tabular-nums",
      }}
      onMouseEnter={(e) => {
        if (!isLink) return
        e.currentTarget.style.background = tier.hoverBg
      }}
      onMouseLeave={(e) => {
        if (!isLink) return
        e.currentTarget.style.background = tier.bg
      }}
    >
      <span
        style={{
          fontFamily: "'DM Serif Display', serif",
          fontSize: 15,
          letterSpacing: "-0.01em",
          lineHeight: 1,
        }}
      >
        {course.rmp_score.toFixed(1)}
      </span>
      <span style={{ opacity: 0.85, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        RMP
      </span>
      {course.rmp_difficulty !== null && (
        <span style={{ opacity: 0.7, fontSize: 11, fontWeight: 500, letterSpacing: "0.02em" }}>
          · Diff {course.rmp_difficulty?.toFixed(1)}
        </span>
      )}
      {course.would_take_again !== null && (
        <span style={{ opacity: 0.7, fontSize: 11, fontWeight: 500, letterSpacing: "0.02em" }}>
          · {course.would_take_again.toFixed(2)}% retake
        </span>
      )}
    </a>
  )
}

function SeatIndicator({ course }: { course: CourseEntry }) {
  const pctRemaining =
    course.total_seats > 0 ? course.seats_available / course.total_seats : 0

  const label =
    course.seats_available === 0
      ? "Full"
      : pctRemaining < 0.30
      ? `${course.seats_available} seats left`
      : `${course.seats_available} of ${course.total_seats} seats`

  const isHealthy = course.seat_color === "#FFFFFF"
  const fg = isHealthy ? "var(--text-tertiary)" : course.seat_color
  const border = isHealthy ? "var(--border-default)" : course.seat_color

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "4px 10px",
        borderRadius: 8,
        color: fg,
        border: `1px solid ${border}`,
        background: "var(--bg-card)",
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  )
}

function RunnerUpRow({
  runner,
  onSwap,
}: {
  runner: RunnerUp
  onSwap: () => void
}) {
  const rmpTier =
    runner.rmp_score >= 4
      ? "#15803D"
      : runner.rmp_score >= 3
      ? "#9A6700"
      : "#B91C1C"

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 0",
        borderBottom: "1px solid var(--border-subtle)",
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
            {runner.course}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: rmpTier, fontVariantNumeric: "tabular-nums" }}>
            {runner.rmp_score.toFixed(1)} RMP
          </span>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>
          {runner.professor}
        </p>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          {runner.days.join(" / ")} · {formatClockRange(runner.start_time, runner.end_time)}
          {runner.seats_available !== undefined && (
            <span style={{ marginLeft: 8 }}>{runner.seats_available} seats</span>
          )}
        </p>
        {runner.linked_sections.map((ls) => (
          <p key={ls.section_id} style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            {titleCase(ls.section_type)} · {ls.days.join("/")} · {formatTime(ls.start_time)}
          </p>
        ))}
      </div>
      <button
        onClick={onSwap}
        style={{
          flexShrink: 0,
          padding: "8px 16px",
          borderRadius: 10,
          border: "1.5px solid var(--border-default)",
          background: "var(--bg-card)",
          color: "var(--text-primary)",
          fontFamily: "'Inter', sans-serif",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          transition: "border-color 0.15s, background 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--cardinal)"
          e.currentTarget.style.borderColor = "var(--cardinal)"
          e.currentTarget.style.color = "#ffffff"
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--bg-card)"
          e.currentTarget.style.borderColor = "var(--border-default)"
          e.currentTarget.style.color = "var(--text-primary)"
        }}
      >
        Swap
      </button>
    </div>
  )
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginBottom: 6,
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 20,
          fontWeight: 600,
          lineHeight: 1,
          color: "var(--text-primary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </p>
    </div>
  )
}

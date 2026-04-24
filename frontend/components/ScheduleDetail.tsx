// Stage 4: post-selection detail view
// Course list with RMP badges, difficulty, days/times, GE badges, double-count badge
// GE swap panel: runner-up options with client-side conflict check
// Export to Google Calendar (.ics download) + Start Over button
"use client"

import { useState } from "react"
import { CourseEntry, RunnerUp, Schedule, SwapState } from "@/lib/types"
import { generateICS } from "@/lib/icsExport"

interface Props {
  schedule: Schedule
  swapState: SwapState
  onSwap: (originalId: string, replacement: CourseEntry) => void
  onStartOver: () => void
}

export default function ScheduleDetail({
  schedule,
  swapState,
  onSwap,
  onStartOver,
}: Props) {
  const [expandedSwap, setExpandedSwap] = useState<string | null>(null)

  // Apply any client-side swaps on top of the original schedule
  const resolvedCourses = schedule.courses.map((course) =>
    swapState[course.section_id] ?? course
  )

  const handleExport = () => {
    const icsString = generateICS(schedule, resolvedCourses)
    const blob = new Blob([icsString], { type: "text/calendar" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "trojan-schedule.ics"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">

      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[#990000] text-xs font-mono tracking-widest uppercase mb-1">
            Schedule Details
          </p>
          <h3 className="text-xl font-bold tracking-tight text-white">
            {resolvedCourses.length} Courses · {schedule.total_units} Units
          </h3>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-white/[0.06] border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Export .ics
          </button>
          <button
            onClick={onStartOver}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-white/[0.06] border border-white/10 text-white/70 hover:bg-[#990000] hover:text-white hover:border-[#990000] transition-all"
          >
            Start Over
          </button>
        </div>
      </div>

      {/* Course list */}
      <div className="space-y-3">
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
              // Convert runner-up to a CourseEntry for local state
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
                linked_section: runner.linked_section,
                runner_ups: null,
              }
              onSwap(course.section_id, replacement)
              setExpandedSwap(null)
            }}
          />
        ))}
      </div>

      {/* Summary footer */}
      <div className="bg-white/[0.02] border border-white/[0.07] rounded-2xl p-5">
        <p className="text-white/40 text-xs uppercase tracking-widest font-mono mb-3">
          Schedule Summary
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCell label="Total Units" value={String(schedule.total_units)} />
          <SummaryCell label="Avg RMP" value={schedule.avg_rmp.toFixed(1)} />
          <SummaryCell
            label="Days on Campus"
            value={schedule.days_with_class.join(", ")}
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

// ── Course row ────────────────────────────────────────────────────────────────

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
  const formatTime = (t: string) => {
    const [h, m] = t.split(":").map(Number)
    const ampm = h >= 12 ? "pm" : "am"
    const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
    return `${hour}:${m.toString().padStart(2, "0")}${ampm}`
  }

  const formatDays = (days: string[]) => days.join(" / ")

  return (
    <div className="bg-white/[0.02] border border-white/[0.07] rounded-2xl overflow-hidden">

      {/* Main row */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">

          {/* Left — course info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-white font-bold text-base tracking-tight">
                {course.course}
              </span>

              {/* GE badge */}
              {course.entry_type === "ge" && course.ge_slot && (
                <span className="text-[0.6rem] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/20">
                  {course.ge_slot}
                </span>
              )}

              {/* Double-count badge */}
              {course.is_double_count && (
                <span className="text-[0.6rem] font-bold px-1.5 py-0.5 rounded bg-[#FFCC00]/15 text-[#FFCC00] border border-[#FFCC00]/25">
                  ✦ 2× GE: {course.double_count_categories.join(" + ")}
                </span>
              )}

              {/* Section type */}
              <span className="text-[0.6rem] text-white/25 font-mono uppercase">
                {course.section_type}
              </span>
            </div>

            <p className="text-white/50 text-sm mb-2">{course.professor}</p>

            {/* Schedule info */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/35">
              <span>{formatDays(course.days)} · {formatTime(course.start_time)} – {formatTime(course.end_time)}</span>
              <span>{course.location}</span>
              <span>{course.units} units</span>
              <span
                className="capitalize"
                style={{ color: course.modality === "online" ? "#60a5fa" : undefined }}
              >
                {course.modality.replace("_", " ")}
              </span>
            </div>

            {/* Linked section */}
            {course.linked_section && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/25 pl-3 border-l border-white/10">
                <span className="capitalize text-white/35">{course.linked_section.section_type}</span>
                <span>
                  {formatDays(course.linked_section.days)} · {formatTime(course.linked_section.start_time)} – {formatTime(course.linked_section.end_time)}
                </span>
                <span>{course.linked_section.location}</span>
              </div>
            )}
          </div>

          {/* Right — RMP + seats */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <RMPBadge course={course} />
            <SeatIndicator course={course} />
          </div>
        </div>

        {/* GE swap toggle */}
        {course.entry_type === "ge" && course.runner_ups && course.runner_ups.length > 0 && (
          <button
            onClick={onToggleSwap}
            className="mt-3 text-xs text-white/35 hover:text-white/60 transition-colors flex items-center gap-1"
          >
            <span>{isSwapOpen ? "▲" : "▼"}</span>
            {isSwapOpen ? "Hide alternatives" : `${course.runner_ups.length} alternative${course.runner_ups.length > 1 ? "s" : ""} available`}
          </button>
        )}
      </div>

      {/* Swap panel */}
      {isSwapOpen && course.runner_ups && (
        <div className="border-t border-white/[0.06] bg-white/[0.02] px-4 py-3 space-y-2">
          <p className="text-white/30 text-xs font-mono uppercase tracking-wider mb-3">
            Alternative courses for {course.ge_slot}
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

// ── RMP badge ─────────────────────────────────────────────────────────────────

function RMPBadge({ course }: { course: CourseEntry }) {
  if (course.no_rmp_data) {
    return (
      <span className="text-xs text-white/25 border border-white/10 px-2 py-0.5 rounded-lg">
        No ratings
      </span>
    )
  }

  const color =
    course.rmp_score >= 4
      ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
      : course.rmp_score >= 3
      ? "text-yellow-400 bg-yellow-400/10 border-yellow-400/20"
      : "text-red-400 bg-red-400/10 border-red-400/20"

  return (
    <div className="flex flex-col items-end gap-0.5">
      <a
        href={course.rmp_profile_url ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-xs font-bold px-2 py-0.5 rounded-lg border transition-opacity hover:opacity-80 ${color}`}
      >
        ⭐ {course.rmp_score.toFixed(1)}
      </a>
      {course.rmp_difficulty !== null && (
        <span className="text-[0.6rem] text-white/25">
          Difficulty {course.rmp_difficulty?.toFixed(1)}
        </span>
      )}
      {course.would_take_again !== null && (
        <span className="text-[0.6rem] text-white/25">
          {course.would_take_again}% again
        </span>
      )}
    </div>
  )
}

// ── Seat indicator ────────────────────────────────────────────────────────────

function SeatIndicator({ course }: { course: CourseEntry }) {
  const pctRemaining =
    course.total_seats > 0
      ? course.seats_available / course.total_seats
      : 0

  const label =
    course.seats_available === 0
      ? "Full"
      : pctRemaining < 0.30
      ? `${course.seats_available} seats left`
      : `${course.seats_available} / ${course.total_seats} seats`

  return (
    <span
      className="text-[0.6rem] font-semibold px-1.5 py-0.5 rounded"
      style={{
        backgroundColor: course.seat_color + "22",
        color: course.seat_color === "#FFFFFF" ? "rgba(255,255,255,0.4)" : course.seat_color,
        border: `1px solid ${course.seat_color}33`,
      }}
    >
      {label}
    </span>
  )
}

// ── Runner-up row ─────────────────────────────────────────────────────────────

function RunnerUpRow({
  runner,
  onSwap,
}: {
  runner: RunnerUp
  onSwap: () => void
}) {
  const formatTime = (t: string) => {
    const [h, m] = t.split(":").map(Number)
    const ampm = h >= 12 ? "pm" : "am"
    const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
    return `${hour}:${m.toString().padStart(2, "0")}${ampm}`
  }

  const rmpColor =
    runner.rmp_score >= 4
      ? "text-emerald-400"
      : runner.rmp_score >= 3
      ? "text-yellow-400"
      : "text-red-400"

  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-white/[0.04] last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-white/70 text-sm font-medium">{runner.course}</span>
          <span className={`text-xs font-bold ${rmpColor}`}>
            ⭐ {runner.rmp_score.toFixed(1)}
          </span>
        </div>
        <p className="text-white/35 text-xs">{runner.professor}</p>
        <p className="text-white/25 text-xs">
          {runner.days.join(" / ")} · {formatTime(runner.start_time)} – {formatTime(runner.end_time)}
          {runner.seats_available !== undefined && (
            <span className="ml-2">{runner.seats_available} seats</span>
          )}
        </p>
        {runner.linked_section && (
          <p className="text-white/20 text-xs mt-0.5">
            + {runner.linked_section.section_type} ·{" "}
            {runner.linked_section.days.join("/")} · {formatTime(runner.linked_section.start_time)}
          </p>
        )}
      </div>
      <button
        onClick={onSwap}
        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/[0.06] border border-white/10 text-white/60 hover:bg-[#990000] hover:text-white hover:border-[#990000] transition-all"
      >
        Swap
      </button>
    </div>
  )
}

// ── Summary cell ──────────────────────────────────────────────────────────────

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-white/30 text-xs mb-1">{label}</p>
      <p className="text-white font-semibold text-sm">{value}</p>
    </div>
  )
}
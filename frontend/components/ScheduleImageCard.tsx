// Stage 3: schedule image card
// Renders base64 PNG calendar image for one schedule option
// Shows score badge, units, avg RMP below image
// "Select Schedule A/B/C" button — on select, others fade to 30% opacity
"use client"

import { Schedule } from "@/lib/types"

interface Props {
  schedule: Schedule
  label: string        // "A" | "B" | "C"
  isSelected: boolean
  dimmed: boolean
  onSelect: (schedule: Schedule) => void
}

export default function ScheduleImageCard({
  schedule,
  label,
  isSelected,
  dimmed,
  onSelect,
}: Props) {
  const isPlaceholder =
    !schedule.image_base64 || schedule.image_base64.startsWith("PLACEHOLDER")

  return (
    <div
      className={`rounded-2xl overflow-hidden border transition-all duration-500 flex flex-col ${
        isSelected
          ? "border-[#990000] ring-2 ring-[#990000]/25 shadow-lg shadow-[#990000]/10"
          : dimmed
          ? "border-white/[0.04] opacity-30 pointer-events-none"
          : "border-white/10 hover:border-white/20"
      }`}
    >
      {/* Header strip */}
      <div className="bg-white/[0.04] px-4 py-2.5 flex items-center justify-between border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <span className="text-white font-bold text-sm tracking-wide">
            Schedule {label}
          </span>
          {isSelected && (
            <span className="text-[0.6rem] font-bold bg-[#990000] text-white px-1.5 py-0.5 rounded-md tracking-wide">
              SELECTED
            </span>
          )}
        </div>
        <span className="text-white/35 text-xs font-mono">
          {schedule.total_units} units
        </span>
      </div>

      {/* Calendar image */}
      <div className="relative bg-white/[0.02] aspect-[11/7]">
        {!isPlaceholder ? (
          <img
            src={`data:image/png;base64,${schedule.image_base64}`}
            alt={`Schedule ${label} calendar`}
            className="w-full h-full object-cover"
          />
        ) : (
          <PlaceholderGrid schedule={schedule} label={label} />
        )}
      </div>

      {/* Score pills */}
      <div className="bg-white/[0.03] px-4 py-3 flex items-center gap-2 flex-wrap border-t border-white/[0.06]">
        <ScoreBadge score={schedule.score} />
        <Pill label={`⭐ ${schedule.avg_rmp.toFixed(1)} RMP`} />
        <Pill label={`📅 ${schedule.days_with_class.length}d / wk`} />
        {schedule.gap_minutes > 0 && (
          <Pill label={`⏱ ${schedule.gap_minutes}m gaps`} />
        )}
      </div>

      {/* Select button */}
      <div className="px-4 pb-4 pt-2">
        <button
          onClick={() => onSelect(schedule)}
          disabled={isSelected}
          className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all ${
            isSelected
              ? "bg-[#990000] text-white cursor-default"
              : "bg-white/[0.06] text-white/70 hover:bg-[#990000] hover:text-white border border-white/10 hover:border-[#990000]"
          }`}
        >
          {isSelected ? `✓  Schedule ${label} Selected` : `Select Schedule ${label}`}
        </button>
      </div>
    </div>
  )
}

// ── Score badge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 85
      ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
      : score >= 70
      ? "text-yellow-400 bg-yellow-400/10 border-yellow-400/20"
      : "text-red-400 bg-red-400/10 border-red-400/20"

  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-bold border ${color}`}>
      {score} / 100
    </span>
  )
}

// ── Generic pill ──────────────────────────────────────────────────────────────

function Pill({ label }: { label: string }) {
  return (
    <span className="px-2 py-0.5 rounded-md bg-white/[0.06] text-white/50 text-xs border border-white/[0.06]">
      {label}
    </span>
  )
}

// ── Placeholder grid (shown when image_base64 is not yet available) ────────────

function PlaceholderGrid({
  schedule,
  label,
}: {
  schedule: Schedule
  label: string
}) {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]
  const COLORS = [
    "bg-[#990000]/70",
    "bg-blue-600/70",
    "bg-emerald-600/70",
    "bg-purple-600/70",
    "bg-orange-500/70",
  ]

  // Map each course to a color index
  const courseColors: Record<string, string> = {}
  schedule.courses.forEach((c, i) => {
    courseColors[c.course] = COLORS[i % COLORS.length]
  })

  // Convert "HH:MM" to a 0–1 position within 8am–8pm (720 min window)
  const toPos = (time: string) => {
    const [h, m] = time.split(":").map(Number)
    return Math.max(0, Math.min(1, (h * 60 + m - 480) / 720))
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Day headers */}
      <div className="flex border-b border-white/[0.06]">
        <div className="w-8 shrink-0" />
        {DAYS.map((day) => (
          <div
            key={day}
            className={`flex-1 text-center text-[0.6rem] font-semibold py-1 ${
              schedule.days_with_class.includes(day)
                ? "text-white/50"
                : "text-white/15"
            }`}
          >
            {day}
          </div>
        ))}
      </div>

      {/* Grid body */}
      <div className="flex flex-1 relative">
        {/* Time gutter */}
        <div className="w-8 shrink-0 relative">
          {["8a", "10a", "12p", "2p", "4p", "6p"].map((t, i) => (
            <div
              key={t}
              className="absolute right-1 text-[0.5rem] text-white/20 leading-none"
              style={{ top: `${(i / 5) * 100}%` }}
            >
              {t}
            </div>
          ))}
        </div>

        {/* Day columns */}
        {DAYS.map((day) => (
          <div
            key={day}
            className={`flex-1 relative border-l border-white/[0.04] ${
              !schedule.days_with_class.includes(day) ? "bg-white/[0.01]" : ""
            }`}
          >
            {/* Hour lines */}
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="absolute w-full border-t border-white/[0.04]"
                style={{ top: `${(i / 5) * 100}%` }}
              />
            ))}

            {/* Course blocks */}
            {schedule.courses.map((course) => {
              if (!course.days.includes(day)) return null
              const top = toPos(course.start_time)
              const height = toPos(course.end_time) - top
              const color =
                course.is_double_count
                  ? "bg-[#FFCC00]/80 text-[#1a1a00]"
                  : course.entry_type === "ge"
                  ? "bg-orange-500/70 text-white"
                  : `${courseColors[course.course]} text-white`

              return (
                <div
                  key={course.section_id}
                  className={`absolute left-0.5 right-0.5 rounded-sm px-0.5 overflow-hidden ${color}`}
                  style={{
                    top: `${top * 100}%`,
                    height: `${Math.max(height * 100, 4)}%`,
                  }}
                >
                  <p className="text-[0.5rem] font-bold leading-tight truncate pt-0.5">
                    {course.course}
                  </p>
                </div>
              )
            })}

            {/* Linked section blocks */}
            {schedule.courses.map((course) => {
              if (!course.linked_section) return null
              if (!course.linked_section.days.includes(day)) return null
              const ls = course.linked_section
              const top = toPos(ls.start_time)
              const height = toPos(ls.end_time) - top

              return (
                <div
                  key={`${course.section_id}-linked`}
                  className="absolute left-0.5 right-0.5 rounded-sm px-0.5 overflow-hidden bg-white/20"
                  style={{
                    top: `${top * 100}%`,
                    height: `${Math.max(height * 100, 3)}%`,
                  }}
                >
                  <p className="text-[0.45rem] text-white/70 leading-tight truncate pt-0.5">
                    {ls.section_type}
                  </p>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Label overlay */}
      <div className="absolute bottom-2 right-2 bg-black/50 text-white/30 text-[0.55rem] font-mono px-1.5 py-0.5 rounded">
        Preview · Schedule {label}
      </div>
    </div>
  )
}
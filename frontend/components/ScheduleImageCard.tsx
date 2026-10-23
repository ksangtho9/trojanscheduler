// Stage 3: schedule card. Renders a CSS schedule grid (no PNG) plus a
// 4-metric strip and the select action.
"use client"

import { Schedule } from "@/lib/types"
import ScheduleGrid from "./ScheduleGrid"

interface Props {
  schedule: Schedule
  label: string        // "A" | "B" | "C"
  isSelected: boolean
  dimmed: boolean
  onSelect: (schedule: Schedule) => void
  planningMode?: boolean
}

export default function ScheduleImageCard({
  schedule,
  label,
  isSelected,
  dimmed,
  onSelect,
  planningMode = false,
}: Props) {
  const fullCount = planningMode
    ? schedule.courses.filter((c) => c.seats_available === 0).length
    : 0

  const borderColor = isSelected ? "var(--cardinal)" : "var(--border-subtle)"
  const borderWidth = isSelected ? 1.5 : 1

  return (
    <div
      onClick={() => onSelect(schedule)}
      style={{
        background: "var(--bg-card)",
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: 20,
        boxShadow: isSelected
          ? "0 12px 32px rgba(153,0,0,0.12), 0 2px 6px rgba(153,0,0,0.06)"
          : "0 1px 2px rgba(0,0,0,0.04)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        opacity: dimmed ? 0.55 : 1,
        transition: "transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, opacity 0.2s ease",
      }}
      onMouseEnter={(e) => {
        if (isSelected) return
        e.currentTarget.style.transform = "translateY(-4px)"
        e.currentTarget.style.boxShadow = "0 18px 36px rgba(0,0,0,0.08), 0 4px 10px rgba(0,0,0,0.04)"
        e.currentTarget.style.borderColor = "var(--border-default)"
        if (dimmed) e.currentTarget.style.opacity = "0.85"
      }}
      onMouseLeave={(e) => {
        if (isSelected) return
        e.currentTarget.style.transform = "translateY(0)"
        e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)"
        e.currentTarget.style.borderColor = "var(--border-subtle)"
        if (dimmed) e.currentTarget.style.opacity = "0.55"
      }}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <div style={{ padding: "24px 24px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div>
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              marginBottom: 6,
            }}
          >
            Option {schedule.rank} / 3
          </p>
          <h3
            style={{
              fontFamily: "'DM Serif Display', serif",
              fontSize: 44,
              lineHeight: 1,
              color: "var(--text-primary)",
              letterSpacing: "-0.02em",
            }}
          >
            {label}
          </h3>
        </div>

        <div style={{ textAlign: "right" }}>
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              marginBottom: 6,
            }}
          >
            Score
          </p>
          <p
            style={{
              fontFamily: "'DM Serif Display', serif",
              fontSize: 34,
              lineHeight: 1,
              color: scoreColor(schedule.score),
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {Math.round(schedule.score)}
          </p>
        </div>
      </div>

      {/* ── Schedule grid (CSS, not PNG) ───────────────── */}
      <div style={{ padding: "0 16px" }}>
        <div
          className="schedule-card-grid"
          style={{
            borderRadius: 14,
            overflow: "hidden",
            background: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            aspectRatio: "11 / 7",
            position: "relative",
          }}
        >
          <ScheduleGrid schedule={schedule} size="compact" />
        </div>
      </div>

      {/* ── Metrics ────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          padding: "20px 24px",
          gap: 12,
        }}
      >
        <Metric label="Units" value={schedule.total_units.toString()} />
        <Metric label="Avg RMP" value={schedule.avg_rmp.toFixed(1)} />
        <Metric label="Days" value={schedule.days_with_class.length.toString()} />
        <Metric
          label="Gaps"
          value={schedule.gap_minutes > 0 ? `${schedule.gap_minutes}m` : "0m"}
        />
      </div>

      {/* ── Status chip (planning mode warnings) ───────── */}
      {fullCount > 0 && (
        <div style={{ padding: "0 24px 16px" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              background: "rgba(153,0,0,0.06)",
              color: "var(--cardinal)",
              border: "1px solid rgba(153,0,0,0.20)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cardinal)" }} />
            {fullCount} full section{fullCount > 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* ── Action ────────────────────────────────────── */}
      <div style={{ padding: "0 16px 16px", marginTop: "auto" }}>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onSelect(schedule)
          }}
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: 12,
            border: "none",
            fontFamily: "'Inter', sans-serif",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "0.01em",
            cursor: "pointer",
            background: isSelected ? "var(--cardinal)" : "var(--text-primary)",
            color: "#ffffff",
            transition: "background 0.15s ease, transform 0.1s ease",
          }}
          onMouseEnter={(e) => {
            if (isSelected) {
              e.currentTarget.style.background = "var(--cardinal-dark)"
            } else {
              e.currentTarget.style.background = "var(--cardinal)"
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = isSelected ? "var(--cardinal)" : "var(--text-primary)"
          }}
        >
          {isSelected ? `Selected` : `Select Schedule ${label}`}
        </button>
      </div>
    </div>
  )
}

// ── Metric cell ───────────────────────────────────────────────────────────────

function Metric({ label, value }: { label: string; value: string }) {
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

// ── Score tier color ──────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 85) return "#157A42" // emerald 700
  if (score >= 70) return "var(--cardinal)"
  return "#9B6B00"                  // muted gold/amber
}

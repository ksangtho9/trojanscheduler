// Shared clock-time helpers. USC's API returns "TBA" (or nothing) for sections
// without a fixed meeting time, so every formatter must tolerate a value that
// is not "HH:MM" instead of crashing on it.

/** Minutes since midnight for a 24h "HH:MM" string, or null for TBA/malformed. */
export function clockMinutes(t: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(t ?? "")
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * "13:30" → "1:30pm", "09:00" → "9am" (compact), or "1:30 pm" / "9:00 am"
 * (spaced). Anything that isn't a clock time renders as "TBA".
 */
export function formatClock(
  t: string | null | undefined,
  style: "compact" | "spaced" = "compact",
): string {
  const total = clockMinutes(t)
  if (total === null) return "TBA"
  const h = Math.floor(total / 60)
  const m = total % 60
  const ampm = h >= 12 ? "pm" : "am"
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
  const mm = String(m).padStart(2, "0")
  if (style === "spaced") return `${hour}:${mm} ${ampm}`
  return m === 0 ? `${hour}${ampm}` : `${hour}:${mm}${ampm}`
}

/** "10:00 to 11:50" style range; collapses to "TBA" when either end is unknown. */
export function formatClockRange(
  start: string | null | undefined,
  end: string | null | undefined,
  sep = " to ",
  style: "compact" | "spaced" = "compact",
): string {
  if (clockMinutes(start) === null || clockMinutes(end) === null) return "TBA"
  return `${formatClock(start, style)}${sep}${formatClock(end, style)}`
}

// generateICS(schedule: Schedule): string
// Builds RFC 5545 iCalendar string for all courses in the selected schedule
// Maps recurring days to RRULE (e.g. BYDAY=MO,WE)
// Triggers browser download as trojan-schedule.ics
import { CourseEntry, Schedule } from "@/lib/types"

// ---------------------------------------------------------------------------
// Day mappings
// ---------------------------------------------------------------------------

const DAY_TO_RRULE: Record<string, string> = {
  Mon: "MO",
  Tue: "TU",
  Wed: "WE",
  Thu: "TH",
  Fri: "FR",
  Sat: "SA",
  Sun: "SU",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * USC Fall 2025 semester start date — Monday Sept 1 2025.
 * Used as the anchor to compute the first occurrence of each class.
 * Update this constant each semester.
 */
const SEMESTER_START = new Date("2025-09-01")
const SEMESTER_END_DATE = "20251205"   // Dec 5 2025 — last day of classes

/**
 * Find the first date on or after SEMESTER_START that falls on
 * the given weekday (0 = Sun, 1 = Mon, ..., 6 = Sat).
 */
function firstOccurrence(weekday: number): Date {
  const d = new Date(SEMESTER_START)
  while (d.getDay() !== weekday) {
    d.setDate(d.getDate() + 1)
  }
  return d
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/**
 * Format a Date + time string ("HH:MM") into a local iCal DTSTART/DTEND
 * string: YYYYMMDDTHHmmss
 */
function formatDT(date: Date, time: string): string {
  const [h, m] = time.split(":").map(Number)
  const d = new Date(date)
  d.setHours(h, m, 0, 0)

  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}00`
  )
}

/**
 * Generate a stable UID for a calendar event.
 * Uses section_id + day so each day gets its own UID.
 */
function makeUID(sectionId: string, day: string): string {
  return `trojanscheduler-${sectionId}-${day}@usc.edu`
}

/**
 * Escape special characters for iCal text fields.
 */
function escapeICS(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
}

/**
 * Fold long lines per RFC 5545 (max 75 octets, continuation with CRLF + space).
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line
  let result = ""
  let remaining = line
  while (remaining.length > 75) {
    result += remaining.slice(0, 75) + "\r\n "
    remaining = remaining.slice(75)
  }
  result += remaining
  return result
}

// ---------------------------------------------------------------------------
// Event builder
// ---------------------------------------------------------------------------

interface EventBlock {
  sectionId: string
  sectionType: string
  course: string
  professor: string
  location: string
  days: string[]
  startTime: string
  endTime: string
  notes?: string
}

function buildEvent(block: EventBlock): string {
  const { sectionId, sectionType, course, professor, location, days, startTime, endTime, notes } = block

  // Use the first day to anchor DTSTART/DTEND
  // RRULE handles the repeating pattern across all days
  const firstDay = days[0]
  const firstDate = firstOccurrence(WEEKDAY_INDEX[firstDay] ?? 1)

  const dtStart = formatDT(firstDate, startTime)
  const dtEnd = formatDT(firstDate, endTime)

  const byday = days.map((d) => DAY_TO_RRULE[d] ?? "MO").join(",")
  const rrule = `FREQ=WEEKLY;BYDAY=${byday};UNTIL=${SEMESTER_END_DATE}T235959Z`

  const summary = `${course} — ${sectionType.charAt(0).toUpperCase() + sectionType.slice(1)}`
  const description = [
    `Professor: ${professor}`,
    notes ?? "",
  ].filter(Boolean).join("\\n")

  const uid = makeUID(sectionId, firstDay)
  const now = formatDT(new Date(), "00:00").replace("T000000", `T${new Date().toISOString().slice(11, 13)}${new Date().toISOString().slice(14, 16)}00`)

  const lines = [
    "BEGIN:VEVENT",
    foldLine(`UID:${uid}`),
    foldLine(`DTSTAMP:${now}`),
    foldLine(`DTSTART;TZID=America/Los_Angeles:${dtStart}`),
    foldLine(`DTEND;TZID=America/Los_Angeles:${dtEnd}`),
    foldLine(`RRULE:${rrule}`),
    foldLine(`SUMMARY:${escapeICS(summary)}`),
    foldLine(`DESCRIPTION:${escapeICS(description)}`),
    foldLine(`LOCATION:${escapeICS(location)}`),
    "END:VEVENT",
  ]

  return lines.join("\r\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete RFC 5545 iCalendar string for a schedule.
 *
 * Each course produces one VEVENT with a weekly RRULE covering the semester.
 * If the course has a linked section (discussion/lab), that gets its own
 * separate VEVENT so it appears as a distinct block on the calendar.
 *
 * @param schedule   The selected Schedule (used for metadata only)
 * @param courses    Resolved course list (post-swap)
 * @returns          iCal string ready to download as .ics
 */
export function generateICS(schedule: Schedule, courses: CourseEntry[]): string {
  const events: string[] = []

  for (const course of courses) {
    // Skip courses with no days (shouldn't happen but defensive)
    if (!course.days?.length) continue

    // Lecture / main section event
    events.push(
      buildEvent({
        sectionId: course.section_id,
        sectionType: course.section_type,
        course: course.course,
        professor: course.professor,
        location: course.location,
        days: course.days,
        startTime: course.start_time,
        endTime: course.end_time,
        notes: [
          course.entry_type === "ge" && course.ge_slot
            ? `GE: ${course.ge_slot}`
            : "",
          course.is_double_count
            ? `Double-counts for: ${course.double_count_categories.join(" + ")}`
            : "",
          course.rmp_score
            ? `RMP: ${course.rmp_score.toFixed(1)} / 5.0`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      })
    )

    // Linked section events (discussion, lab, quiz, etc.)
    for (const ls of course.linked_sections) {
      if (!ls.days?.length) continue
      events.push(
        buildEvent({
          sectionId: `${course.section_id}-${ls.section_id}`,
          sectionType: ls.section_type,
          course: course.course,
          professor: course.professor,
          location: ls.location,
          days: ls.days,
          startTime: ls.start_time,
          endTime: ls.end_time,
        })
      )
    }
  }

  const calendarLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Trojan Scheduler//USC Fall 2025//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:USC Schedule — Rank ${schedule.rank}`,
    "X-WR-TIMEZONE:America/Los_Angeles",
    ...events,
    "END:VCALENDAR",
  ]

  return calendarLines.join("\r\n")
}
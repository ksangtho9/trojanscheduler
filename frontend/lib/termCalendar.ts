/**
 * First and last day of classes for each USC term, used to bound the
 * recurring events in the .ics export.
 *
 * Term codes are YYYY + season digit (1 = Spring, 2 = Summer, 3 = Fall).
 * Official dates come from https://www.usc.edu/academic-calendar/ (checked
 * 2026-10-22). Add each new term here when USC publishes it; until then the
 * export falls back to an estimate built from USC's usual pattern.
 */

export interface TermDates {
  /** First day of classes, YYYY-MM-DD */
  start: string
  /** Last day of classes, YYYY-MM-DD */
  end: string
}

const OFFICIAL_TERM_DATES: Record<string, TermDates> = {
  "20263": { start: "2026-08-24", end: "2026-12-04" }, // Fall 2026
  "20271": { start: "2027-01-11", end: "2027-04-30" }, // Spring 2027
  "20272": { start: "2027-05-19", end: "2027-08-10" }, // Summer 2027
}

const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The nth (1-based) given weekday of a month. weekday: 0 = Sun ... 6 = Sat */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const d = new Date(year, month, 1)
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1)
  d.setDate(d.getDate() + 7 * (n - 1))
  return d
}

/** The last given weekday of a month. */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const d = new Date(year, month + 1, 0)
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
  return d
}

/**
 * Estimate for terms not in the official table, following USC's usual shape:
 * Spring starts the 2nd Monday of January and ends the last Friday of April,
 * Summer runs mid-May to about Aug 10, Fall starts the 4th Monday of August
 * and ends the first Friday of December.
 */
function estimateTermDates(termCode: string): TermDates | null {
  const year = Number(termCode.slice(0, 4))
  const season = termCode.slice(4)
  if (!Number.isFinite(year)) return null
  if (season === "1") {
    return { start: ymd(nthWeekday(year, 0, 1, 2)), end: ymd(lastWeekday(year, 3, 5)) }
  }
  if (season === "2") {
    return { start: `${year}-05-19`, end: `${year}-08-10` }
  }
  if (season === "3") {
    return { start: ymd(nthWeekday(year, 7, 1, 4)), end: ymd(nthWeekday(year, 11, 5, 1)) }
  }
  return null
}

/** Class dates for a term: official when known, otherwise estimated. */
export function getTermDates(termCode: string | undefined): TermDates | null {
  if (!termCode) return null
  return OFFICIAL_TERM_DATES[termCode] ?? estimateTermDates(termCode)
}

/** Parse YYYY-MM-DD as a local date (not UTC midnight, which shifts the day west of UTC). */
export function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d)
}

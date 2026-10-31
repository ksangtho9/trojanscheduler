// Course colors shared by the calendar grid and the course chips in the form,
// so a course shows the same color in both places.

// Tasteful, distinguishable palette. Cardinal sits at index 0 so the USC
// signature anchors when a schedule has only one course.
export const COURSE_PALETTE = [
  "#A30019", // USC cardinal
  "#3730A3", // indigo
  "#047857", // emerald
  "#6D28D9", // violet
  "#B45309", // amber
  "#0E7490", // teal
  "#BE185D", // rose
  "#1D4ED8", // blue
  "#15803D", // green
  "#9333EA", // purple
]
export const GE_COLOR = "#C2410C" // burnt orange

// Stable hash by course code, used as the *starting* palette index so a course
// tends to keep the same color everywhere it appears.
export function hashIndex(courseCode: string): number {
  let h = 0
  for (const ch of courseCode) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(h) % COURSE_PALETTE.length
}

// Give each code a UNIQUE palette color: seed from the stable hash, then
// linear-probe to the next free color on collision, so two different courses
// in the same set never share a color (e.g. EE 141 vs CSCI 170).
export function assignCourseColors(codes: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>()
  const used = new Set<string>()
  for (const code of codes) {
    if (map.has(code)) continue
    let idx = hashIndex(code)
    for (let i = 0; i < COURSE_PALETTE.length; i++) {
      const candidate = COURSE_PALETTE[(idx + i) % COURSE_PALETTE.length]
      if (!used.has(candidate)) {
        idx = (idx + i) % COURSE_PALETTE.length
        break
      }
    }
    const color = COURSE_PALETTE[idx]
    used.add(color)
    map.set(code, color)
  }
  return map
}

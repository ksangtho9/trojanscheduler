"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react"
import {
  Constraints,
  CourseInputEntry,
  DiscussionOption,
  GenerateRequest,
  Term,
  TermsResponse,
} from "@/lib/types"
import LeftPanel from "./LeftPanel"

// Every course lookup in this form is term-specific. Carried by context rather
// than prop-drilled: the lookups live in leaf components several levels below
// the term picker, and widening each intermediate signature to pass it through
// would touch far more of this file than the feature warrants.
const TermContext = createContext<string>("")
const useTermCode = () => useContext(TermContext)

const GE_CATEGORIES = ["A", "B", "C", "D", "E", "F", "G", "H", "GESM"]

const GE_CATEGORY_LABELS: Record<string, string> = {
  A: "The Arts",
  B: "Humanistic Inquiry",
  C: "Social Analysis",
  D: "Life Sciences",
  E: "Physical Sciences",
  F: "Quantitative Reasoning",
  G: "Global Perspectives I",
  H: "Global Perspectives II",
  GESM: "General Education Seminar",
}

const TIME_MIN_MINUTES = 7 * 60
const TIME_MAX_MINUTES = 22 * 60
const TIME_STEP = 30
const MAX_TIME_INDEX = (TIME_MAX_MINUTES - TIME_MIN_MINUTES) / TIME_STEP

interface Entry {
  id: number
  type: "course" | "ge"
  code: string
  professor: string
  section_id: string
  category: string
  expanded: boolean
}

interface SectionOption {
  section_id: string
  professor: string
  days: string[]
  start_time: string
  end_time: string
  seats_available: number
  total_seats: number
}

interface CourseOptions {
  professors: string[]
  sections: SectionOption[]
}

interface Props {
  onSubmit: (payload: GenerateRequest) => void
  error: string | null
  discussionPromptCourse: string | null
  discussionOptions: DiscussionOption[]
  // Which linked-section type the picker is currently asking about. The same
  // UI handles discussion, lab, and quiz prompts — the backend tells us which.
  promptType: "discussion" | "lab" | "quiz"
  onDiscussionPreference: (pref: Record<string, Record<string, string>>) => void
}

let _id = 0
const newEntry = (): Entry => ({
  id: ++_id,
  type: "course",
  code: "",
  professor: "",
  section_id: "",
  category: "",
  expanded: false,
})

const DEFAULT_CONSTRAINTS: Constraints = {
  earliest_start: "08:00",
  latest_end: "20:00",
  days_off: [],
  max_units: 16,
  no_back_to_back: false,
  modality: "in_person",
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}

function minutesToHHMM(total: number): string {
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`
}

function clampTimeMinutes(m: number): number {
  const clamped = Math.min(TIME_MAX_MINUTES, Math.max(TIME_MIN_MINUTES, m))
  const steps = Math.round((clamped - TIME_MIN_MINUTES) / TIME_STEP)
  return TIME_MIN_MINUTES + steps * TIME_STEP
}

function timeToIndex(time: string): number {
  const m = clampTimeMinutes(timeToMinutes(time))
  return Math.round((m - TIME_MIN_MINUTES) / TIME_STEP)
}

function indexToTime(idx: number): string {
  const bounded = Math.min(MAX_TIME_INDEX, Math.max(0, idx))
  return minutesToHHMM(TIME_MIN_MINUTES + bounded * TIME_STEP)
}

function autoHyphen(s: string): string {
  // "BUAD3" → "BUAD-3", "EE109" → "EE-109"; already-hyphenated strings unchanged
  return s.replace(/^([A-Za-z]{2,5})(\d)/, "$1-$2")
}

function entryFilled(e: Entry): boolean {
  return Boolean(e.code.trim() || e.category)
}

function pillLabel(e: Entry): string {
  if (e.type === "ge") {
    if (e.category === "GESM") return "GESM"
    if (e.category) return `GE ${e.category}`
    return "GE"
  }
  return e.code.trim().toUpperCase().replace(" ", "-") || "Course"
}

// ── Course autocomplete ────────────────────────────────────────────────────────

// Course lists are per-term static files. Cached by term code so switching
// back to a term already viewed doesn't refetch.
type CourseList = { code: string; title: string; units?: number | null }[]
const _cachedCourses: Record<string, CourseList> = {}

function useCourses(termCode: string) {
  const [courses, setCourses] = useState<CourseList>(_cachedCourses[termCode] ?? [])
  useEffect(() => {
    if (!termCode) { setCourses([]); return }
    const cached = _cachedCourses[termCode]
    if (cached) { setCourses(cached); return }
    let cancelled = false
    fetch(`/courses.${termCode}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then((data: CourseList) => {
        _cachedCourses[termCode] = data
        if (!cancelled) setCourses(data)
      })
      // A term whose file hasn't been generated yet degrades to no
      // autocomplete rather than breaking the form — the user can still type
      // a course code and submit.
      .catch(() => { if (!cancelled) setCourses([]) })
    return () => { cancelled = true }
  }, [termCode])
  return courses
}

// GE-tagged courses, keyed by category letter. Loaded once and cached.
type GeCourseMap = Record<string, { code: string; title: string; units?: number | null }[]>
const _cachedGeCourses: Record<string, GeCourseMap> = {}

function useGeCourses(termCode: string) {
  const [data, setData] = useState<GeCourseMap>(_cachedGeCourses[termCode] ?? {})
  useEffect(() => {
    if (!termCode) { setData({}); return }
    const cached = _cachedGeCourses[termCode]
    if (cached) { setData(cached); return }
    let cancelled = false
    fetch(`/ge_courses.${termCode}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then((d: GeCourseMap) => {
        _cachedGeCourses[termCode] = d
        if (!cancelled) setData(d)
      })
      .catch(() => { if (!cancelled) setData({}) })
    return () => { cancelled = true }
  }, [termCode])
  return data
}

// ── Course options (professors + time slots) ───────────────────────────────────

// Keyed by term AND course: the same course has different professors and time
// slots each term, so a term-blind cache would show Fall's sections while the
// user is building a Spring schedule.
const _optionsCache: Record<string, CourseOptions> = {}

function useCourseOptions(code: string, termCode: string) {
  const [options, setOptions] = useState<CourseOptions | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const course = code.trim().toUpperCase()
    if (!course || !termCode) { setOptions(null); return }
    const key = `${termCode}:${course}`
    if (_optionsCache[key]) { setOptions(_optionsCache[key]); return }
    setLoading(true)
    let cancelled = false
    const base = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000"
    fetch(`${base}/course-options?code=${encodeURIComponent(course)}&term=${encodeURIComponent(termCode)}`)
      .then((r) => r.json())
      .then((data: CourseOptions) => {
        _optionsCache[key] = data
        if (!cancelled) setOptions(data)
      })
      .catch(() => { if (!cancelled) setOptions({ professors: [], sections: [] }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [code, termCode])
  return { options, loading }
}

function formatSectionLabel(s: SectionOption): string {
  const days = s.days.join("/")
  const time = `${s.start_time} to ${s.end_time}`
  if (s.seats_available === 0) return `${days} ${time}`
  const seats = s.seats_available === 1 ? "1 seat" : `${s.seats_available} seats`
  return `${days} ${time}  ·  ${seats} open`
}

function ProfessorDropdown({
  professors,
  value,
  onChange,
  announced,
}: {
  professors: string[]
  value: string
  onChange: (prof: string) => void
  announced: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const label = value || "Any professor"

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 4,
          padding: "6px 10px",
          fontSize: 13,
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          background: "white",
          cursor: "pointer",
          color: value ? "var(--text-primary)" : "var(--text-tertiary)",
          outline: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span style={{ flexShrink: 0, color: "var(--text-tertiary)", fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "white",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          <div
            onClick={() => { onChange(""); setOpen(false) }}
            style={{
              padding: "8px 10px",
              fontSize: 13,
              cursor: "pointer",
              color: value === "" ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: value === "" ? 600 : 400,
              borderBottom: "1px solid var(--border-default)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle, #f9f9f9)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            Any professor
          </div>
          {!announced ? (
            <div style={{ padding: "10px 10px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
              Professors will be announced later
            </div>
          ) : (
            professors.map((p) => (
              <div
                key={p}
                onClick={() => { onChange(p); setOpen(false) }}
                style={{
                  padding: "8px 10px",
                  fontSize: 13,
                  cursor: "pointer",
                  color: "var(--text-primary)",
                  fontWeight: p === value ? 600 : 400,
                  background: p === value ? "rgba(153,0,0,0.06)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = p === value ? "rgba(153,0,0,0.10)" : "var(--bg-subtle, #f9f9f9)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = p === value ? "rgba(153,0,0,0.06)" : "transparent"
                }}
              >
                {p}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function SectionDropdown({
  sections,
  value,
  onChange,
}: {
  sections: SectionOption[]
  value: string
  onChange: (sid: string, prof: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const selected = sections.find((s) => s.section_id === value)

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "4px",
          padding: "6px 10px",
          fontSize: "13px",
          border: "1px solid var(--border-default)",
          borderRadius: "8px",
          background: "white",
          cursor: "pointer",
          color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
          outline: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? formatSectionLabel(selected) : "Any time"}
        </span>
        <span style={{ flexShrink: 0, color: "var(--text-tertiary)", fontSize: "11px" }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "white",
            border: "1px solid var(--border-default)",
            borderRadius: "8px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
            maxHeight: "220px",
            overflowY: "auto",
          }}
        >
          <div
            onClick={() => { onChange("", ""); setOpen(false) }}
            style={{
              padding: "8px 10px",
              fontSize: "13px",
              cursor: "pointer",
              color: value === "" ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: value === "" ? 600 : 400,
              borderBottom: "1px solid var(--border-default)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle, #f9f9f9)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            Any time
          </div>
          {sections.map((s) => {
            const isFull = s.seats_available === 0
            const isSelected = s.section_id === value
            return (
              <div
                key={s.section_id}
                onClick={() => { onChange(s.section_id, s.professor); setOpen(false) }}
                style={{
                  padding: "8px 10px",
                  fontSize: "13px",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "8px",
                  background: isFull ? "rgba(220,38,38,0.06)" : isSelected ? "rgba(153,0,0,0.06)" : "transparent",
                  color: isFull ? "rgba(160,20,20,0.75)" : "var(--text-primary)",
                  fontWeight: isSelected ? 600 : 400,
                }}
                onMouseEnter={(e) => {
                  if (!isFull) e.currentTarget.style.background = isSelected ? "rgba(153,0,0,0.10)" : "var(--bg-subtle, #f9f9f9)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isFull ? "rgba(220,38,38,0.06)" : isSelected ? "rgba(153,0,0,0.06)" : "transparent"
                }}
              >
                <span>{formatSectionLabel(s)}</span>
                {isFull && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: "10px",
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: "99px",
                      background: "rgba(220,38,38,0.12)",
                      color: "rgba(160,20,20,0.85)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    FULL
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DeptCourseSearchInput({
  value,
  onChange,
  onCommitCourse,
  onCommitGE,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onCommitCourse: (code: string) => void
  onCommitGE: (category: string, geCode?: string) => void
  placeholder: string
}) {
  const termCode = useTermCode()
  const courses = useCourses(termCode)
  const geCourses = useGeCourses(termCode)
  const [open, setOpen] = useState(false)
  const [geExpanded, setGeExpanded] = useState(false)
  // When set, the GE drill-down is showing the per-category course list
  // (third level of navigation: Requirements → Category → Class).
  const [selectedGeCategory, setSelectedGeCategory] = useState<string | null>(null)
  const [selectedDept, setSelectedDept] = useState<string | null>(null)
  const [hiIdx, setHiIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const depts = useMemo(() => {
    const set = new Set<string>()
    for (const c of courses) {
      const prefix = c.code.split(" ")[0]
      if (prefix) set.add(prefix)
    }
    return Array.from(set).sort()
  }, [courses])

  // Normalize hyphens to spaces so "EE-109" matches course code "EE 109"
  const q = value.trim().toUpperCase().replace(/-/g, " ")

  // Typing a hyphen or space (e.g. "CSCI-270" or "CSCI 270") = direct course search
  const typedCourseSearch = selectedDept === null && (value.includes("-") || value.includes(" ")) && q.trim().length >= 2

  const filteredDepts = selectedDept === null && !typedCourseSearch
    ? (q ? depts.filter((d) => d.startsWith(q) || d.includes(q)) : depts)
    : []

  const deptCourses = selectedDept !== null
    ? courses.filter((c) => {
        if (c.code.split(" ")[0] !== selectedDept) return false
        if (!q) return true
        return c.code.toUpperCase().includes(q) || c.title.toUpperCase().includes(q)
      })
    : []

  const globalSuggestions = typedCourseSearch
    ? courses
        .filter((c) => c.code.startsWith(q) || c.title.toUpperCase().includes(q))
        .sort((a, b) => {
          const aEx = a.code.startsWith(q), bEx = b.code.startsWith(q)
          if (aEx !== bEx) return aEx ? -1 : 1
          return a.code.localeCompare(b.code)
        })
        .slice(0, 10)
    : []

  const panel: "dept-browser" | "dept-courses" | "course-search" | "ge-categories" | "ge-courses" =
    selectedDept !== null      ? "dept-courses"
    : selectedGeCategory !== null ? "ge-courses"
    : geExpanded               ? "ge-categories"
    : typedCourseSearch        ? "course-search"
    : "dept-browser"

  const navItems =
    panel === "dept-courses" ? deptCourses :
    panel === "course-search" ? globalSuggestions :
    panel === "ge-categories" ? GE_CATEGORIES.map((c) => ({ code: c, title: GE_CATEGORY_LABELS[c] })) :
    panel === "ge-courses" && selectedGeCategory ? (geCourses[selectedGeCategory] || []) :
    filteredDepts

  const closeAll = () => {
    setOpen(false)
    setSelectedDept(null)
    setGeExpanded(false)
    setSelectedGeCategory(null)
  }

  const commitCourse = (code: string) => {
    onCommitCourse(code.replace(/-/g, " "))
    onChange("")
    closeAll()
  }

  const drillIntoDept = (dept: string) => {
    setSelectedDept(dept)
    onChange("")
    setHiIdx(0)
  }

  const goBack = () => {
    setSelectedDept(null)
    onChange("")
    setHiIdx(0)
  }

  // GE drill-down: enter category list, enter a specific category, step back.
  const drillIntoGE = () => {
    setGeExpanded(true)
    setSelectedGeCategory(null)
    onChange("")
    setHiIdx(0)
  }
  const drillIntoGeCategory = (cat: string) => {
    setSelectedGeCategory(cat)
    onChange("")
    setHiIdx(0)
  }
  const backFromGeCourses = () => {
    setSelectedGeCategory(null)
    onChange("")
    setHiIdx(0)
  }
  const backFromGeCategories = () => {
    setGeExpanded(false)
    setSelectedGeCategory(null)
    onChange("")
    setHiIdx(0)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) closeAll()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const dropdownStyle: CSSProperties = {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 9999,
    borderRadius: 8,
    border: "1px solid var(--border-default)",
    background: "var(--bg-card)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
    marginTop: 2,
    maxHeight: 300,
    overflowY: "auto",
  }

  const courseRow = (c: { code: string; title: string; units?: number | null }, i: number) => (
    <button
      key={c.code}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => commitCourse(c.code)}
      onMouseEnter={() => setHiIdx(i)}
      style={{
        display: "flex",
        alignItems: "baseline",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        background: i === hiIdx ? "rgba(153,0,0,0.07)" : "transparent",
        border: "none",
        cursor: "pointer",
        gap: 6,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", letterSpacing: "0.03em", flexShrink: 0 }}>
        {c.code.replace(" ", "-")}
      </span>
      {c.title && (
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.title}
        </span>
      )}
      {c.units != null && (
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0, marginLeft: "auto" }}>
          {c.units} {c.units === 1 ? "unit" : "units"}
        </span>
      )}
    </button>
  )

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1 }}>
      <input
        ref={inputRef}
        type="text"
        className="form-add-input"
        placeholder={selectedDept ? `Filter ${selectedDept} courses…` : placeholder}
        value={value}
        onChange={(e) => { onChange(autoHyphen(e.target.value)); setOpen(true); setHiIdx(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setHiIdx((i) => Math.min(i + 1, navItems.length - 1))
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setHiIdx((i) => Math.max(i - 1, 0))
          } else if (e.key === "Enter") {
            e.preventDefault()
            if (panel === "dept-courses") {
              if (deptCourses[hiIdx]) commitCourse(deptCourses[hiIdx].code)
              else if (value.trim()) commitCourse(value.trim().toUpperCase())
            } else if (panel === "course-search") {
              if (globalSuggestions[hiIdx]) commitCourse(globalSuggestions[hiIdx].code)
              else if (value.trim()) commitCourse(value.trim().toUpperCase())
            } else if (panel === "ge-categories") {
              const cat = GE_CATEGORIES[hiIdx]
              if (cat) drillIntoGeCategory(cat)
            } else if (panel === "ge-courses" && selectedGeCategory) {
              const list = geCourses[selectedGeCategory] || []
              if (list[hiIdx]) { onCommitGE(selectedGeCategory, list[hiIdx].code); onChange(""); closeAll() }
            } else {
              if (filteredDepts[hiIdx]) drillIntoDept(filteredDepts[hiIdx])
              else if (value.trim()) commitCourse(value.trim().toUpperCase())
            }
          } else if (e.key === "Escape") {
            e.preventDefault()
            if (selectedDept !== null) goBack()
            else if (selectedGeCategory !== null) backFromGeCourses()
            else if (geExpanded) backFromGeCategories()
            else closeAll()
          } else if (e.key === "Backspace" && !value) {
            if (selectedDept !== null) { e.preventDefault(); goBack() }
            else if (selectedGeCategory !== null) { e.preventDefault(); backFromGeCourses() }
            else if (geExpanded) { e.preventDefault(); backFromGeCategories() }
          }
        }}
      />

      {open && (
        <div style={dropdownStyle}>

          {/* ── Dept course list ────────────────────────── */}
          {panel === "dept-courses" && (
            <>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={goBack}
                style={{
                  position: "sticky", top: 0, zIndex: 1,
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", padding: "7px 10px",
                  background: "var(--bg-card)", border: "none",
                  borderBottom: "1px solid var(--border-subtle)", cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle, #f9f9f9)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-card)")}
              >
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>◀</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", letterSpacing: "0.03em" }}>
                  {selectedDept}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Pick a course</span>
              </button>
              {deptCourses.length === 0
                ? <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    {q ? `No matches for "${q}"` : "No courses listed"}
                  </div>
                : deptCourses.map(courseRow)
              }
            </>
          )}

          {/* ── Direct course search (typed "DEPT NUM") ── */}
          {panel === "course-search" && (
            globalSuggestions.length === 0
              ? <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No matches</div>
              : globalSuggestions.map(courseRow)
          )}

          {/* ── Dept browser (departments + GE Requirements row at top) ── */}
          {panel === "dept-browser" && (
            <>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={drillIntoGE}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", textAlign: "left", padding: "7px 10px",
                  background: "rgba(255,204,0,0.06)",
                  borderBottom: "1px solid var(--border-subtle)",
                  border: "none", cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,204,0,0.14)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,204,0,0.06)")}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <PinIcon />
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#8A6D00", fontFamily: "monospace", letterSpacing: "0.03em" }}>GE</span>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: 2 }}>GE Requirements</span>
                </span>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>▶</span>
              </button>

              {filteredDepts.length === 0
                ? <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No departments match</div>
                : filteredDepts.map((dept, i) => (
                  <button
                    key={dept}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => drillIntoDept(dept)}
                    onMouseEnter={() => setHiIdx(i)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", textAlign: "left", padding: "6px 10px",
                      background: i === hiIdx ? "rgba(153,0,0,0.06)" : "transparent",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", letterSpacing: "0.03em" }}>
                      {dept}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>▶</span>
                  </button>
                ))
              }
            </>
          )}

          {/* ── GE categories list (after clicking "GE Requirements") ── */}
          {panel === "ge-categories" && (
            <>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={backFromGeCategories}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", textAlign: "left", padding: "7px 10px",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "transparent", border: "none", cursor: "pointer",
                  fontSize: 11, color: "var(--text-tertiary)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle, #f9f9f9)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontSize: 12 }}>◀</span>
                <span>All departments</span>
              </button>

              {GE_CATEGORIES.map((cat, i) => {
                const count = (geCourses[cat] || []).length
                return (
                  <button
                    key={cat}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => drillIntoGeCategory(cat)}
                    onMouseEnter={() => setHiIdx(i)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      width: "100%", textAlign: "left", padding: "7px 10px",
                      background: i === hiIdx ? "rgba(255,204,0,0.14)" : "transparent",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#8A6D00", fontFamily: "monospace", letterSpacing: "0.03em", minWidth: 22 }}>
                      {cat}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {GE_CATEGORY_LABELS[cat]}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-tertiary)" }}>
                      {count} classes ▶
                    </span>
                  </button>
                )
              })}
            </>
          )}

          {/* ── GE class list (after clicking a category) ───────── */}
          {panel === "ge-courses" && selectedGeCategory && (
            <>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={backFromGeCourses}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", textAlign: "left", padding: "7px 10px",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "transparent", border: "none", cursor: "pointer",
                  fontSize: 11, color: "var(--text-tertiary)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle, #f9f9f9)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontSize: 12 }}>◀</span>
                <span>All GE categories</span>
              </button>

              {/* Auto Pick — commits as the whole category (no specific class).
                  Pill on the form shows just "GE F". */}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onCommitGE(selectedGeCategory); onChange(""); closeAll() }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", textAlign: "left", padding: "9px 12px",
                  background: "rgba(255,204,0,0.08)",
                  borderBottom: "1px solid rgba(255,204,0,0.20)",
                  border: "none", cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,204,0,0.18)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,204,0,0.08)")}
              >
                <span style={{ fontSize: 12, fontWeight: 700, color: "#8A6D00", fontFamily: "monospace", letterSpacing: "0.03em", minWidth: 22 }}>
                  {selectedGeCategory}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Auto Pick</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    Let the program choose a {GE_CATEGORY_LABELS[selectedGeCategory]} class
                  </span>
                </span>
              </button>

              {(geCourses[selectedGeCategory] || []).map((c, i) => (
                <button
                  key={c.code}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onCommitGE(selectedGeCategory, c.code); onChange(""); closeAll() }}
                  onMouseEnter={() => setHiIdx(i)}
                  style={{
                    display: "flex", alignItems: "baseline", gap: 10,
                    width: "100%", textAlign: "left", padding: "6px 12px",
                    background: i === hiIdx ? "rgba(153,0,0,0.06)" : "transparent",
                    border: "none", cursor: "pointer",
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", letterSpacing: "0.03em", minWidth: 70 }}>
                    {c.code}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.title}
                  </span>
                </button>
              ))}

              {(geCourses[selectedGeCategory] || []).length === 0 && (
                <div style={{ padding: "12px 12px", fontSize: 11, fontStyle: "italic", color: "var(--text-tertiary)" }}>
                  No classes found for this category.
                </div>
              )}
            </>
          )}

        </div>
      )}
    </div>
  )
}

export default function InputForm({
  onSubmit,
  error,
  discussionPromptCourse,
  discussionOptions,
  promptType,
  onDiscussionPreference,
}: Props) {
  const [mustHaves, setMustHaves] = useState<Entry[]>([])
  const [niceToHaves, setNiceToHaves] = useState<Entry[]>([])
  const [draftMust, setDraftMust] = useState("")
  const [draftNice, setDraftNice] = useState("")
  const [editingMustId, setEditingMustId] = useState<number | null>(null)
  const [editingNiceId, setEditingNiceId] = useState<number | null>(null)
  const [constraints, setConstraints] = useState<Constraints>(DEFAULT_CONSTRAINTS)
  const [profSlider, setProfSlider] = useState(0.5)
  const [convSlider, setConvSlider] = useState(0.5)
  const [showDaysOff, setShowDaysOff] = useState(false)
  const [rankingsOpen, setRankingsOpen] = useState(false)
  const [planningMode, setPlanningMode] = useState(true)
  const [autoPickMode, setAutoPickMode] = useState(false)
  const [terms, setTerms] = useState<Term[]>([])
  // Empty until /terms answers. The backend owns both the active set and which
  // one is default, so neither rule is duplicated here.
  const [termCode, setTermCode] = useState("")

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000"
    let cancelled = false
    fetch(`${base}/terms`)
      .then((r) => r.json())
      .then((d: TermsResponse) => {
        if (cancelled) return
        setTerms(d.terms ?? [])
        setTermCode(d.default ?? d.terms?.[0]?.term_code ?? "")
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const updateEntry = (
    list: Entry[],
    setList: (l: Entry[]) => void,
    id: number,
    patch: Partial<Entry>
  ) => setList(list.map((e) => (e.id === id ? { ...e, ...patch } : e)))

  const deleteEntryAndClearEdit = (
    list: Entry[],
    setList: (l: Entry[]) => void,
    id: number,
    clearEditing: (id: number | null) => void,
    currentEdit: number | null
  ) => {
    setList(list.filter((e) => e.id !== id))
    if (currentEdit === id) clearEditing(null)
  }

  const toApiEntry = (e: Entry): CourseInputEntry => {
    if (e.type === "course") {
      return {
        type: "course",
        code: e.code.trim().toUpperCase().replace(/-/g, " ") || undefined,
        professor: e.professor.trim() || undefined,
        section_id: e.section_id.trim() || undefined,
      }
    }
    return {
      type: "ge",
      category: e.category || undefined,
      // entry.code, when set on a GE entry, is the user-picked specific
      // course inside that category. Submit it as ge_code so the backend's
      // auto_select_ge restricts that GE slot to this exact course.
      ge_code: e.code.trim().toUpperCase().replace(/-/g, " ") || undefined,
    }
  }

  const handleSubmit = () => {
    onSubmit({
      must_haves: mustHaves.filter(entryFilled).map(toApiEntry),
      nice_to_haves: niceToHaves.filter(entryFilled).map(toApiEntry),
      constraints,
      prof_slider: profSlider,
      convenience_slider: convSlider,
      planning_mode: planningMode,
      auto_pick_mode: autoPickMode,
      term_code: termCode || undefined,
    })
  }

  const commitDraftMust = () => {
    const code = draftMust.trim().toUpperCase()
    if (!code || mustHaves.length >= 6) return
    setMustHaves([...mustHaves, { ...newEntry(), code, type: "course" }])
    setDraftMust("")
  }

  const commitDraftNice = () => {
    const code = draftNice.trim().toUpperCase()
    if (!code || niceToHaves.length >= 4) return
    setNiceToHaves([...niceToHaves, { ...newEntry(), code, type: "course" }])
    setDraftNice("")
  }

  const commitCodeMust = (code: string) => {
    if (!code || mustHaves.length >= 6) return
    setMustHaves((prev) => [...prev, { ...newEntry(), code, type: "course" }])
    setDraftMust("")
  }

  const commitCodeNice = (code: string) => {
    if (!code || niceToHaves.length >= 4) return
    setNiceToHaves((prev) => [...prev, { ...newEntry(), code, type: "course" }])
    setDraftNice("")
  }

  const commitGEMust = (category: string, geCode?: string) => {
    if (mustHaves.length >= 6) return
    setMustHaves((prev) => [...prev, { ...newEntry(), type: "ge", category, code: geCode ?? "" }])
    setDraftMust("")
  }

  const commitGENice = (category: string, geCode?: string) => {
    if (niceToHaves.length >= 4) return
    setNiceToHaves((prev) => [...prev, { ...newEntry(), type: "ge", category, code: geCode ?? "" }])
    setDraftNice("")
  }

  const earliestIdx = timeToIndex(constraints.earliest_start)
  const latestIdx = timeToIndex(constraints.latest_end)

  const applyTimeRangeIndices = useCallback((lo: number, hi: number) => {
    const loB = Math.min(MAX_TIME_INDEX, Math.max(0, lo))
    const hiB = Math.min(MAX_TIME_INDEX, Math.max(0, hi))
    const earliest = Math.min(loB, hiB)
    const latest = Math.max(loB, hiB)
    setConstraints((c) => ({
      ...c,
      earliest_start: indexToTime(earliest),
      latest_end: indexToTime(latest),
    }))
  }, [])

  // ── linked-section prompt ──────────────────────────────────────────────────
  // Same UI handles discussion / lab / quiz — the type is driven by promptType.

  if (discussionPromptCourse) {
    const typeLabel = promptType.charAt(0).toUpperCase() + promptType.slice(1)
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <LeftPanel currentStep={1} />
        <div style={{ marginLeft: "var(--content-offset)", width: "var(--content-width)", minHeight: "100vh", backgroundColor: "var(--bg-page)", display: "flex", alignItems: "center", justifyContent: "center", paddingTop: "calc(var(--topbar-height) + 48px)", paddingBottom: 48 }} className="app-discussion-inner">
          <div style={{ maxWidth: 520, width: "100%" }}>
            {/* Header — surfaces the system-selected lecturer so the link
                between "options shown" and "lecturer chosen" is explicit.
                Falls back to a generic header if no options yet. */}
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <p
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "var(--cardinal)",
                  marginBottom: 14,
                }}
              >
                Step 02 / {typeLabel}
              </p>
              <h3 style={{ fontFamily: "'DM Serif Display', serif", color: "var(--text-primary)", fontSize: 32, marginBottom: 12, letterSpacing: "-0.01em", lineHeight: 1.05 }}>
                Pick a {promptType} time.
              </h3>
              {discussionOptions.length > 0 ? (
                <>
                  <p style={{ color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>
                    We selected{" "}
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {discussionOptions[0].lecture_professor}
                    </span>
                    {" "}for{" "}
                    <span style={{ fontWeight: 600, color: "var(--cardinal)" }}>{discussionPromptCourse}</span>
                    . All {promptType} options below pair with their lecture.
                  </p>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      borderRadius: 999,
                      background: "rgba(153,0,0,0.06)",
                      border: "1px solid rgba(153,0,0,0.15)",
                      color: "var(--cardinal)",
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: "0.02em",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cardinal)" }} />
                    Lecture · {discussionOptions[0].lecture_days.join(" / ")} · {formatTime(discussionOptions[0].lecture_start_time)} to {formatTime(discussionOptions[0].lecture_end_time)}
                  </div>
                </>
              ) : (
                <p style={{ color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6 }}>
                  <span style={{ fontWeight: 600, color: "var(--cardinal)" }}>{discussionPromptCourse}</span>
                  {" "}has multiple {promptType} sections.
                </p>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

              {/* "No preference" — auto-pick, surfaced FIRST as the recommended path. */}
              <button
                type="button"
                onClick={() => onDiscussionPreference({ [discussionPromptCourse]: {} })}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "14px 16px",
                  borderRadius: 12,
                  border: "1.5px solid var(--cardinal)",
                  background: "rgba(153,0,0,0.04)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  transition: "background 0.15s, transform 0.1s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(153,0,0,0.08)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(153,0,0,0.04)"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "var(--cardinal)" }}>
                    No preference, let the program pick
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: "var(--cardinal)",
                      background: "#ffffff",
                      border: "1px solid rgba(153,0,0,0.25)",
                      padding: "3px 7px",
                      borderRadius: 4,
                    }}
                  >
                    Recommended
                  </span>
                </div>
                <p style={{ fontSize: 12, marginTop: 6, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  Show the three highest-scoring schedules across all lecturers and {promptType} times.
                </p>
              </button>

              {/* Subtle divider between auto and manual options */}
              {discussionOptions.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0 4px" }}>
                  <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>
                    Or pick manually
                  </span>
                  <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                </div>
              )}

              {discussionOptions.map((opt) => {
                const isFull = opt.seats_available === 0
                const pctRemaining = opt.total_seats > 0 ? opt.seats_available / opt.total_seats : 0
                const t = Math.min(1, pctRemaining / 0.7)
                const g = Math.round(255 * t)
                const b = Math.round(255 * t)
                const bgColor = `rgba(255,${g},${b},0.10)`
                const borderColor = isFull
                  ? "rgba(153,0,0,0.55)"
                  : pctRemaining < 0.3
                  ? "rgba(153,0,0,0.35)"
                  : "var(--border-default)"
                return (
                  <button
                    key={`${opt.lecture_section_id}-${opt.section_id}`}
                    onClick={() =>
                      onDiscussionPreference({
                        [discussionPromptCourse]: {
                          // Pin the lecture too so a later prompt round (e.g.
                          // lab after discussion) stays on the same professor.
                          lecture_section_id: opt.lecture_section_id,
                          [promptType]: opt.section_id,
                        },
                      })
                    }
                    style={{ width: "100%", textAlign: "left", padding: "12px 16px", borderRadius: 12, border: `1.5px solid ${borderColor}`, backgroundColor: bgColor, color: "var(--text-primary)", cursor: "pointer", transition: "border-color 0.15s" }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--cardinal)" }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = borderColor }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontWeight: 500, fontSize: 14 }}>
                        {opt.days.join(" / ")} · {formatTime(opt.start_time)} to {formatTime(opt.end_time)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0, color: isFull ? "var(--cardinal)" : pctRemaining < 0.3 ? "var(--cardinal)" : "var(--text-tertiary)" }}>
                        {isFull ? "Full" : `${opt.seats_available} / ${opt.total_seats}`}
                      </span>
                    </div>
                    {opt.location && (
                      <p style={{ fontSize: 11, marginTop: 4, color: "var(--text-tertiary)" }}>{opt.location}</p>
                    )}
                  </button>
                )
              })}

              {discussionOptions.length === 0 && (
                <p style={{ textAlign: "center", padding: "24px 0", fontSize: 14, color: "var(--text-tertiary)" }}>
                  No {promptType} options available.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── main form ──────────────────────────────────────────────────────────────

  const fillUnits = ((constraints.max_units - 8) / 12) * 100

  return (
    <TermContext.Provider value={termCode}>
    <div style={{ display: "flex", minHeight: "100vh" }}>

      <LeftPanel currentStep={1} />

      <div style={{ marginLeft: "var(--content-offset)", width: "var(--content-width)", minHeight: "100vh", backgroundColor: "var(--bg-page)" }}>
        <div className="app-form-inner" style={{ maxWidth: 860, margin: "0 auto", paddingTop: "calc(var(--topbar-height) + 32px)", paddingRight: 56, paddingBottom: 80, paddingLeft: 56 }}>

          {/* Mode toggles — top right */}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 16, marginBottom: 20 }}>
            {/* Term picker — sits with the global mode controls, not the form */}
            {terms.length > 1 && (
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", userSelect: "none" as const }}>
                  Term
                </span>
                <select
                  value={termCode}
                  onChange={(e) => setTermCode(e.target.value)}
                  aria-label="Select term"
                  style={{
                    appearance: "none" as const,
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--cardinal)",
                    background: "#FFFFFF",
                    border: "1px solid var(--border-default)",
                    borderRadius: 8,
                    padding: "5px 26px 5px 10px",
                    cursor: "pointer",
                    backgroundImage:
                      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>\")",
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 9px center",
                  }}
                >
                  {terms.map((t) => (
                    <option key={t.term_code} value={t.term_code}>{t.label}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Auto Pick toggle */}
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 12, fontWeight: 600, color: autoPickMode ? "var(--cardinal)" : "var(--text-tertiary)", transition: "color 0.2s", userSelect: "none" as const }}>
                Auto Pick
              </span>
              <button
                type="button"
                onClick={() => setAutoPickMode((v) => !v)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                aria-label="Toggle Auto Pick Mode"
              >
                <div className="toggle shrink-0 pointer-events-none" style={{ backgroundColor: autoPickMode ? "var(--cardinal)" : "var(--border-default)", transform: "scale(0.85)", transformOrigin: "center" }}>
                  <div className="toggle-thumb" style={{ transform: autoPickMode ? "translateX(18px)" : "translateX(0)" }} />
                </div>
              </button>
              <div className="relative group" style={{ display: "flex", alignItems: "center" }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-tertiary)", flexShrink: 0, cursor: "help" }}>
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8 7v5M8 5.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <div
                  className="absolute opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150"
                  style={{ top: "calc(100% + 8px)", right: 0, width: 240, background: "#FFFFFF", border: "1px solid var(--border-default)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", zIndex: 50, textAlign: "left" as const }}
                >
                  <div style={{ position: "absolute", top: -5, right: 4, width: 10, height: 10, background: "#FFFFFF", borderTop: "1px solid var(--border-default)", borderLeft: "1px solid var(--border-default)", transform: "rotate(45deg)" }} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Auto Pick</div>
                  <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)" }}>
                    Automatically lets the program choose labs, discussions, and quizzes — skips the picker entirely.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span style={{ fontSize: 12, fontWeight: 600, color: planningMode ? "var(--cardinal)" : "var(--text-tertiary)", transition: "color 0.2s", userSelect: "none" as const }}>
                Planning Mode
              </span>
              <button
                type="button"
                onClick={() => setPlanningMode((v) => !v)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                aria-label="Toggle Planning Mode"
              >
                <div className="toggle shrink-0 pointer-events-none" style={{ backgroundColor: planningMode ? "var(--cardinal)" : "var(--border-default)", transform: "scale(0.85)", transformOrigin: "center" }}>
                  <div className="toggle-thumb" style={{ transform: planningMode ? "translateX(18px)" : "translateX(0)" }} />
                </div>
              </button>
              <div className="relative group" style={{ display: "flex", alignItems: "center" }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-tertiary)", flexShrink: 0, cursor: "help" }}>
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8 7v5M8 5.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                {/* Polished card tooltip */}
                <div
                  className="absolute opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150"
                  style={{ top: "calc(100% + 8px)", right: 0, width: 260, background: "#FFFFFF", border: "1px solid var(--border-default)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", zIndex: 50, textAlign: "left" as const }}
                >
                  <div style={{ position: "absolute", top: -5, right: 4, width: 10, height: 10, background: "#FFFFFF", borderTop: "1px solid var(--border-default)", borderLeft: "1px solid var(--border-default)", transform: "rotate(45deg)" }} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
                    Planning Mode
                  </div>
                  <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)" }}>
                    Includes sections at capacity in your results. Enrollment fluctuates throughout registration; waitlisting a full section is often a viable path.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div style={{ marginBottom: 28, padding: "12px 16px", borderRadius: 10, backgroundColor: "rgba(153,0,0,0.06)", border: "1px solid rgba(153,0,0,0.20)", color: "var(--cardinal)", fontSize: 13 }}>
              {error}
            </div>
          )}

          {/* Required courses */}
          <section style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase" as const, color: "var(--text-secondary)" }}>
                Required courses
              </h2>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{mustHaves.length}/6</span>
            </div>
            <CourseEntryBlock
              entries={mustHaves}
              setEntries={setMustHaves}
              draft={draftMust}
              setDraft={setDraftMust}
              editingId={editingMustId}
              setEditingId={setEditingMustId}
              maxEntries={6}
              draftPlaceholder="Add a course or GE requirement…"
              onCommitDraft={commitDraftMust}
              onCommitCode={commitCodeMust}
              onCommitGE={commitGEMust}
              updateEntry={updateEntry}
              removeEntry={(list, setList, id) =>
                deleteEntryAndClearEdit(list, setList, id, setEditingMustId, editingMustId)
              }
            />
          </section>

          <div style={{ height: 1, background: "var(--border-subtle)", marginBottom: 28 }} />

          {/* Optional courses */}
          <section style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase" as const, color: "var(--text-secondary)" }}>
                Optional courses
              </h2>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{niceToHaves.length}/4</span>
            </div>
            {niceToHaves.filter(entryFilled).length === 0 &&
              !niceToHaves.some((e) => !entryFilled(e)) &&
              editingNiceId === null && (
              <p style={{ fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic", marginBottom: 12 }}>
                No entries yet.
              </p>
            )}
            <CourseEntryBlock
              entries={niceToHaves}
              setEntries={setNiceToHaves}
              draft={draftNice}
              setDraft={setDraftNice}
              editingId={editingNiceId}
              setEditingId={setEditingNiceId}
              maxEntries={4}
              draftPlaceholder="Add an optional course or GE…"
              onCommitDraft={commitDraftNice}
              onCommitCode={commitCodeNice}
              onCommitGE={commitGENice}
              updateEntry={updateEntry}
              removeEntry={(list, setList, id) =>
                deleteEntryAndClearEdit(list, setList, id, setEditingNiceId, editingNiceId)
              }
            />
          </section>

          <div style={{ height: 1, background: "var(--border-subtle)", marginBottom: 28 }} />

          {/* Class window */}
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ margin: "0 0 16px", fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase" as const, color: "var(--text-secondary)" }}>
              Class window
            </h2>

            <div style={{ marginBottom: 24 }}>
              <DualTimeRangeSlider
                earliestIdx={earliestIdx}
                latestIdx={latestIdx}
                onChange={applyTimeRangeIndices}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--text-tertiary)" }}>
                <span>Earliest start</span>
                <span>Latest end</span>
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Max units</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cardinal)", fontVariantNumeric: "tabular-nums" }}>{constraints.max_units}</span>
              </div>
              <input
                type="range"
                className="form-constraint-range"
                min={8}
                max={20}
                step={1}
                value={constraints.max_units}
                onChange={(e) => setConstraints((c) => ({ ...c, max_units: Number(e.target.value) }))}
                style={{ ["--fill-percent" as string]: `${fillUnits}%` }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--text-tertiary)" }}>
                <span>8</span>
                <span>20</span>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                className="form-toggle-box flex items-center justify-between gap-2 cursor-pointer"
                onClick={() => {
                  setShowDaysOff((v) => {
                    const next = !v
                    if (v) setConstraints((c) => ({ ...c, days_off: [] }))
                    return next
                  })
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setShowDaysOff((v) => {
                      if (v) setConstraints((c) => ({ ...c, days_off: [] }))
                      return !v
                    })
                  }
                }}
              >
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Days off</p>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>Pick days you want completely free</p>
                </div>
                <div className="toggle shrink-0 pointer-events-none" style={{ backgroundColor: showDaysOff ? "var(--cardinal)" : "var(--border-default)" }}>
                  <div className="toggle-thumb" style={{ transform: showDaysOff ? "translateX(18px)" : "translateX(0)" }} />
                </div>
              </div>
              {showDaysOff && (
                <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {[
                    { value: "Mon", label: "Monday" },
                    { value: "Tue", label: "Tuesday" },
                    { value: "Wed", label: "Wednesday" },
                    { value: "Thu", label: "Thursday" },
                    { value: "Fri", label: "Friday" },
                  ].map(({ value, label }) => {
                    const isSelected = constraints.days_off.includes(value)
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`form-pill${isSelected ? " is-active" : ""}`}
                        style={{ paddingRight: 10, color: isSelected ? "var(--cardinal)" : undefined }}
                        onClick={() =>
                          setConstraints((c) => ({
                            ...c,
                            days_off: isSelected
                              ? c.days_off.filter((d) => d !== value)
                              : [...c.days_off, value],
                          }))
                        }
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              )}
              <div
                className="form-toggle-box flex items-center justify-between gap-2 cursor-pointer"
                onClick={() => setConstraints((c) => ({ ...c, no_back_to_back: !c.no_back_to_back }))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setConstraints((c) => ({ ...c, no_back_to_back: !c.no_back_to_back }))
                  }
                }}
              >
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>No back-to-back</p>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>Require gaps between classes</p>
                </div>
                <div className="toggle shrink-0 pointer-events-none" style={{ backgroundColor: constraints.no_back_to_back ? "var(--cardinal)" : "var(--border-default)" }}>
                  <div className="toggle-thumb" style={{ transform: constraints.no_back_to_back ? "translateX(18px)" : "translateX(0)" }} />
                </div>
              </div>
            </div>
          </section>

          <div style={{ height: 1, background: "var(--border-subtle)", marginBottom: 28 }} />

          {/* Fine-tune rankings */}
          <section>
            <button
              type="button"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
              onClick={() => setRankingsOpen((o) => !o)}
              aria-expanded={rankingsOpen}
            >
              <h2 style={{ margin: 0, fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase" as const, color: "var(--text-secondary)" }}>
                Fine-tune rankings
              </h2>
              <span className={`form-disclosure-chevron ${rankingsOpen ? "is-open" : ""}`} aria-hidden>
                <ChevronDownIcon />
              </span>
            </button>
            {rankingsOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 24, paddingTop: 16 }}>
                <SliderRow
                  label="Professor Quality"
                  hint="Prioritizes sections with higher RateMyProfessor scores"
                  value={profSlider}
                  onChange={setProfSlider}
                  leftLabel="Less important"
                  rightLabel="Top priority"
                />
                <div style={{ height: 1, background: "var(--border-subtle)" }} />
                <SliderRow
                  label="Schedule Convenience"
                  hint="Prioritizes fewer campus days and less time between classes"
                  value={convSlider}
                  onChange={setConvSlider}
                  leftLabel="Less important"
                  rightLabel="Top priority"
                />
              </div>
            )}
          </section>

        </div>

        <div className="app-submit-footer" style={{ position: "fixed", bottom: 0, left: "var(--content-offset)", right: 0, zIndex: 50, background: "var(--bg-page)", borderTop: "1px solid var(--border-subtle)", padding: "14px 56px" }}>
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <button type="button" onClick={handleSubmit} className="btn-primary w-full py-3 text-sm gap-2 rounded-xl">
              <SparkleIcon />
              Build My Schedule
            </button>
          </div>
        </div>
      </div>

    </div>
    </TermContext.Provider>
  )
}

// ── Dual-handle time range (earliest / latest class window) ─────────────────

function DualTimeRangeSlider({
  earliestIdx,
  latestIdx,
  onChange,
}: {
  earliestIdx: number
  latestIdx: number
  onChange: (earliestIndex: number, latestIndex: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const earliestRef = useRef(earliestIdx)
  const latestRef = useRef(latestIdx)
  earliestRef.current = earliestIdx
  latestRef.current = latestIdx

  const [active, setActive] = useState<"earliest" | "latest" | null>(null)

  const indexFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const t = (clientX - rect.left) / rect.width
    return Math.round(Math.min(1, Math.max(0, t)) * MAX_TIME_INDEX)
  }, [])

  useLayoutEffect(() => {
    if (!active) return
    const onMove = (e: PointerEvent) => {
      const raw = indexFromClientX(e.clientX)
      if (active === "earliest") {
        let lo = raw
        let hi = latestRef.current
        if (lo > hi) hi = lo
        onChange(lo, hi)
      } else {
        let hi = raw
        let lo = earliestRef.current
        if (hi < lo) lo = hi
        onChange(lo, hi)
      }
    }
    const onUp = () => setActive(null)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [active, indexFromClientX, onChange])

  const pct = (idx: number) => (MAX_TIME_INDEX <= 0 ? 0 : (idx / MAX_TIME_INDEX) * 100)
  const lo = Math.min(earliestIdx, latestIdx)
  const hi = Math.max(earliestIdx, latestIdx)
  const fillLeft = pct(lo)
  const fillWidth = pct(hi) - pct(lo)

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const idx = indexFromClientX(e.clientX)
    const pickEarliest = Math.abs(idx - earliestIdx) <= Math.abs(idx - latestIdx)
    setActive(pickEarliest ? "earliest" : "latest")
    if (pickEarliest) {
      let a = idx
      let b = latestIdx
      if (a > b) b = a
      onChange(a, b)
    } else {
      let b = idx
      let a = earliestIdx
      if (b < a) a = b
      onChange(a, b)
    }
  }

  const startLabel = formatTime(indexToTime(earliestIdx))
  const endLabel = formatTime(indexToTime(latestIdx))

  const railStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: 6,
    marginTop: -3,
    borderRadius: 3,
    background: "#E0E0E0",
    zIndex: 0,
  }
  const fillStyle: CSSProperties = {
    position: "absolute",
    top: "50%",
    height: 6,
    marginTop: -3,
    borderRadius: 3,
    background: "var(--cardinal, #990000)",
    left: `${fillLeft}%`,
    width: `${Math.max(0.5, fillWidth)}%`,
    zIndex: 1,
    pointerEvents: "none",
  }
  const thumbBase: CSSProperties = {
    position: "absolute",
    top: "50%",
    width: 16,
    height: 16,
    marginLeft: -8,
    marginTop: -8,
    borderRadius: "50%",
    border: "2px solid var(--cardinal, #990000)",
    background: "#ffffff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
    cursor: "grab",
    zIndex: 3,
    touchAction: "none",
    boxSizing: "border-box",
  }

  return (
    <div className="dual-range">
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cardinal)", fontVariantNumeric: "tabular-nums" }}>
          {startLabel}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cardinal)", fontVariantNumeric: "tabular-nums" }}>
          {endLabel}
        </span>
      </div>
      <div
        ref={trackRef}
        className="dual-range-track"
        style={{
          position: "relative",
          width: "100%",
          height: 16,
          touchAction: "none",
          userSelect: "none",
        }}
        onPointerDown={onTrackPointerDown}
        role="group"
        aria-label="Class hours from earliest start to latest end"
      >
        <div style={railStyle} aria-hidden />
        <div style={fillStyle} aria-hidden />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Earliest start"
          aria-valuemin={0}
          aria-valuemax={MAX_TIME_INDEX}
          aria-valuenow={earliestIdx}
          aria-orientation="horizontal"
          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cardinal)] focus-visible:ring-offset-1"
          style={{ ...thumbBase, left: `${pct(earliestIdx)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setActive("earliest")
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
            e.preventDefault()
            const d = e.key === "ArrowRight" ? 1 : -1
            let lo = Math.min(MAX_TIME_INDEX, Math.max(0, earliestIdx + d))
            let hi = latestIdx
            if (lo > hi) hi = lo
            onChange(lo, hi)
          }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Latest end"
          aria-valuemin={0}
          aria-valuemax={MAX_TIME_INDEX}
          aria-valuenow={latestIdx}
          aria-orientation="horizontal"
          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cardinal)] focus-visible:ring-offset-1"
          style={{ ...thumbBase, left: `${pct(latestIdx)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setActive("latest")
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
            e.preventDefault()
            const d = e.key === "ArrowRight" ? 1 : -1
            let hi = Math.min(MAX_TIME_INDEX, Math.max(0, latestIdx + d))
            let lo = earliestIdx
            if (hi < lo) lo = hi
            onChange(lo, hi)
          }}
        />
      </div>
    </div>
  )
}

// ── Course block (pills + add row + editor) ─────────────────────────────────

function CourseEntryBlock({
  entries,
  setEntries,
  draft,
  setDraft,
  editingId,
  setEditingId,
  maxEntries,
  draftPlaceholder,
  onCommitDraft,
  onCommitCode,
  onCommitGE,
  updateEntry,
  removeEntry,
}: {
  entries: Entry[]
  setEntries: Dispatch<SetStateAction<Entry[]>>
  draft: string
  setDraft: (s: string) => void
  editingId: number | null
  setEditingId: (id: number | null) => void
  maxEntries: number
  draftPlaceholder: string
  onCommitDraft: () => void
  onCommitCode: (code: string) => void
  onCommitGE: (category: string, geCode?: string) => void
  updateEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number, patch: Partial<Entry>) => void
  removeEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number) => void
}) {
  const filled = entries.filter(entryFilled)
  const incomplete = entries.filter((e) => !entryFilled(e))
  const atCap = entries.length >= maxEntries

  return (
    <div className="space-y-1.5">
      {(filled.length > 0 || incomplete.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {filled.map((e) => (
            <div
              key={e.id}
              className={`form-pill ${editingId === e.id ? "is-active" : ""}`}
            >
              <button
                type="button"
                className="bg-transparent border-none cursor-pointer uppercase tracking-wide"
                style={{ color: "inherit", fontFamily: "inherit", fontSize: "inherit", fontWeight: "inherit", outline: "none" }}
                onClick={() => setEditingId(editingId === e.id ? null : e.id)}
              >
                {pillLabel(e)}
              </button>
              <button
                type="button"
                className="form-pill-remove"
                aria-label={`Remove ${pillLabel(e)}`}
                style={{ outline: "none" }}
                onClick={() => removeEntry(entries, setEntries, e.id)}
              >
                ×
              </button>
            </div>
          ))}
          {incomplete.map((e) => (
            <span
              key={e.id}
              className="text-[11px] px-1.5 py-0.5 rounded-md self-center"
              style={{ background: "rgba(255,204,0,0.15)", color: "#8A6D00" }}
            >
              GE (incomplete)
            </span>
          ))}
        </div>
      )}

      {((editingId !== null && entries.some((x) => x.id === editingId)) || incomplete.length > 0) && (
        <div className="rounded-lg p-2.5 space-y-2">
          {editingId !== null && entries.find((x) => x.id === editingId) && (
            <EntryEditor
              entry={entries.find((x) => x.id === editingId)!}
              list={entries}
              setList={setEntries}
              updateEntry={updateEntry}
              removeEntry={removeEntry}
            />
          )}
          {incomplete
            .filter((e) => editingId === null || e.id !== editingId)
            .map((e) => (
              <EntryEditor
                key={e.id}
                entry={e}
                list={entries}
                setList={setEntries}
                updateEntry={updateEntry}
                removeEntry={removeEntry}
              />
            ))}
        </div>
      )}

      {!atCap && (
        <div className="form-add-row">
          <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}>
            <BookIcon />
          </span>
          <DeptCourseSearchInput
            value={draft}
            onChange={setDraft}
            onCommitCourse={onCommitCode}
            onCommitGE={onCommitGE}
            placeholder={draftPlaceholder}
          />
          <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}>
            <ChevronsIcon />
          </span>
        </div>
      )}
    </div>
  )
}

function CourseDetailsSelectors({
  code,
  professor,
  sectionId,
  onProfessorChange,
  onSectionChange,
}: {
  code: string
  professor: string
  sectionId: string
  onProfessorChange: (prof: string) => void
  onSectionChange: (sid: string, prof: string) => void
}) {
  const { options, loading } = useCourseOptions(code, useTermCode())

  const safeProf = professor ?? ""
  const safeSid = sectionId ?? ""

  if (!code.trim()) return null

  if (loading) return null

  if (!options || options.sections.length === 0) return null

  const visibleSections = safeProf
    ? options.sections.filter((s) => s.professor === safeProf)
    : options.sections

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <ProfessorDropdown
        professors={options.professors}
        value={safeProf}
        onChange={onProfessorChange}
        announced={options.professors.length > 0}
      />

      <SectionDropdown
        sections={visibleSections}
        value={safeSid}
        onChange={onSectionChange}
      />
    </div>
  )
}

function EntryEditor({
  entry,
  list,
  setList,
  updateEntry,
  removeEntry,
}: {
  entry: Entry
  list: Entry[]
  setList: (l: Entry[]) => void
  updateEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number, patch: Partial<Entry>) => void
  removeEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
          {entry.type === "ge" ? "GE requirement" : "Edit course"}
        </span>
        <button
          type="button"
          className="text-[11px] font-medium"
          style={{ color: "var(--cardinal)", outline: "none", border: "none", background: "none" }}
          onClick={() => removeEntry(list, setList, entry.id)}
        >
          Remove
        </button>
      </div>

      {entry.type === "course" && (
        <>
          <input
            type="text"
            value={entry.code.replace(" ", "-")}
            onChange={(e) =>
              updateEntry(list, setList, entry.id, {
                code: autoHyphen(e.target.value).replace(/-/g, " "),
              })
            }
            placeholder="e.g. CSCI-270"
            style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
          />
          <CourseDetailsSelectors
            code={entry.code}
            professor={entry.professor}
            sectionId={entry.section_id}
            onProfessorChange={(prof) =>
              updateEntry(list, setList, entry.id, { professor: prof, section_id: "" })
            }
            onSectionChange={(sid, prof) =>
              updateEntry(list, setList, entry.id, {
                section_id: sid,
                professor: prof || entry.professor,
              })
            }
          />
        </>
      )}

      {entry.type === "ge" && (
        <>
          <select
            value={entry.category}
            onChange={(e) =>
              // Reset any picked specific course when the category changes
              // (the previous pick won't belong to the new category).
              updateEntry(list, setList, entry.id, { category: e.target.value, code: "" })
            }
          >
            <option value="">Select GE category…</option>
            {GE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c === "GESM" ? "GESM" : `GE ${c}`} · {GE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>

          {entry.category && (
            <div style={{ marginTop: 10 }}>
              <label
                style={{
                  display: "block",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                  marginBottom: 6,
                }}
              >
                Specific class (optional)
              </label>
              <GeCourseDropdown
                category={entry.category}
                value={entry.code}
                onChange={(code) => updateEntry(list, setList, entry.id, { code })}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── GE-specific-course dropdown ──────────────────────────────────────────────
// Searchable list of all courses tagged with the chosen GE category.
// Default is "Any course in GE X" (empty value → backend auto-picks the best
// scoring option). User can pick one to lock that GE slot to a specific course.

function GeCourseDropdown({
  category,
  value,
  onChange,
}: {
  category: string
  value: string
  onChange: (code: string) => void
}) {
  const geCourses = useGeCourses(useTermCode())
  const list = geCourses[category] ?? []
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false)
        setSearch("")
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return list
    const q = search.trim().toUpperCase()
    return list.filter(
      (c) => c.code.toUpperCase().includes(q) || c.title.toUpperCase().includes(q)
    )
  }, [list, search])

  const selected = list.find((c) => c.code === value)

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 4,
          padding: "8px 12px",
          fontSize: 13,
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          background: "white",
          cursor: "pointer",
          color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
          outline: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? `${selected.code}  ·  ${selected.title}` : `Any course in ${category === "GESM" ? "GESM" : `GE ${category}`}`}
        </span>
        <span style={{ flexShrink: 0, color: "var(--text-tertiary)", fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "white",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
            maxHeight: 320,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--border-subtle)" }}>
            <input
              autoFocus
              type="text"
              placeholder={`Search ${list.length} course${list.length === 1 ? "" : "s"}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 8px",
                fontSize: 13,
                border: "1px solid var(--border-default)",
                borderRadius: 6,
                background: "white",
                outline: "none",
              }}
            />
          </div>

          <div style={{ overflowY: "auto", maxHeight: 260 }}>
            <div
              onClick={() => {
                onChange("")
                setOpen(false)
                setSearch("")
              }}
              style={{
                padding: "8px 12px",
                fontSize: 13,
                cursor: "pointer",
                color: value === "" ? "var(--text-primary)" : "var(--text-secondary)",
                fontWeight: value === "" ? 600 : 400,
                borderBottom: "1px solid var(--border-subtle)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle, #f9f9f9)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              Any course in {category === "GESM" ? "GESM" : `GE ${category}`}
            </div>

            {filtered.length === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-tertiary)", textAlign: "center" }}>
                No matches.
              </div>
            ) : (
              filtered.map((c) => {
                const isSelected = c.code === value
                return (
                  <div
                    key={c.code}
                    onClick={() => {
                      onChange(c.code)
                      setOpen(false)
                      setSearch("")
                    }}
                    style={{
                      padding: "8px 12px",
                      fontSize: 13,
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      background: isSelected ? "rgba(153,0,0,0.06)" : "transparent",
                      fontWeight: isSelected ? 600 : 400,
                      color: "var(--text-primary)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = isSelected
                        ? "rgba(153,0,0,0.10)"
                        : "var(--bg-subtle, #f9f9f9)"
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = isSelected ? "rgba(153,0,0,0.06)" : "transparent"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--text-primary)", flexShrink: 0 }}>
                        {c.code}
                      </span>
                      {c.units != null && (
                        <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: "auto", flexShrink: 0 }}>
                          {c.units} {c.units === 1 ? "unit" : "units"}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.3 }}>
                      {c.title}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SliderRow({
  label,
  hint,
  value,
  onChange,
  leftLabel,
  rightLabel,
}: {
  label: string
  hint: string
  value: number
  onChange: (v: number) => void
  leftLabel: string
  rightLabel: string
}) {
  const fill = value * 100
  return (
    <div>
      <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cardinal)", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(value * 100)}%
        </span>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8, lineHeight: 1.4 }}>{hint}</p>
      <input
        type="range"
        className="form-constraint-range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--fill-percent" as string]: `${fill}%` }}
      />
      <div className="flex justify-between" style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1 }}>
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  )
}

function formatTime(t: string): string {
  const [h, m] = t.split(":").map(Number)
  const ampm = h >= 12 ? "pm" : "am"
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${hour}:${m.toString().padStart(2, "0")} ${ampm}`
}

function PinIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 16" fill="none" aria-hidden style={{ flexShrink: 0, color: "#8A6D00" }}>
      <circle cx="5" cy="4" r="3.5" fill="currentColor" />
      <rect x="4" y="7" width="2" height="8" rx="1" fill="currentColor" />
    </svg>
  )
}

function BookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 15l5 5 5-5M7 9l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
      <path
        d="M12 3l1.2 3.6L17 8l-3.8 1.4L12 13l-1.2-3.6L7 8l3.8-1.4L12 3zM19 14l.6 1.8L21.5 17l-1.9.7L19 19.5l-.6-1.8L16.5 17l1.9-.7L19 14zM5 15l.5 1.5L7 17l-1.5.5L5 19l-.5-1.5L3 17l1.5-.5L5 15z"
        fill="currentColor"
      />
    </svg>
  )
}

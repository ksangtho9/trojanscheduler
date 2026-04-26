"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
} from "@/lib/types"

const GE_CATEGORIES = ["A", "B", "C", "D", "E", "F", "G"]

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
  categories: string[]
  multiGE: boolean
  expanded: boolean
}

interface Props {
  onSubmit: (payload: GenerateRequest) => void
  error: string | null
  discussionPromptCourse: string | null
  discussionOptions: DiscussionOption[]
  onDiscussionPreference: (pref: Record<string, string>) => void
}

let _id = 0
const newEntry = (): Entry => ({
  id: ++_id,
  type: "course",
  code: "",
  professor: "",
  section_id: "",
  category: "",
  categories: [],
  multiGE: false,
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

function entryFilled(e: Entry): boolean {
  return Boolean(
    e.code.trim() ||
      e.category ||
      (e.categories && e.categories.length > 0)
  )
}

function pillLabel(e: Entry): string {
  if (e.type === "ge") {
    if (e.multiGE && e.categories.length) return `GE ${e.categories.sort().join("+")}`
    if (e.category) return `GE ${e.category}`
    return "GE"
  }
  return e.code.trim().toUpperCase() || "Course"
}

// ── Course autocomplete ────────────────────────────────────────────────────────

let _cachedCourses: { code: string; title: string }[] | null = null

function useCourses() {
  const [courses, setCourses] = useState<{ code: string; title: string }[]>(_cachedCourses ?? [])
  useEffect(() => {
    if (_cachedCourses !== null) { setCourses(_cachedCourses); return }
    fetch("/courses.json")
      .then((r) => r.json())
      .then((data) => { _cachedCourses = data; setCourses(data) })
      .catch(() => {})
  }, [])
  return courses
}

function AutocompleteInput({
  value,
  onChange,
  onCommit,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: (code: string) => void
  placeholder: string
}) {
  const courses = useCourses()
  const [open, setOpen] = useState(false)
  const [hiIdx, setHiIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const q = value.trim().toUpperCase()
  const suggestions =
    q.length < 2
      ? []
      : courses
          .filter((c) => c.code.startsWith(q) || c.code.includes(q) || c.title.toUpperCase().includes(q))
          .sort((a, b) => {
            const aStarts = a.code.startsWith(q)
            const bStarts = b.code.startsWith(q)
            if (aStarts !== bStarts) return aStarts ? -1 : 1
            return a.code.localeCompare(b.code)
          })
          .slice(0, 8)

  const showDropdown = open && suggestions.length > 0

  const commit = (code: string) => {
    onCommit(code)
    onChange("")
    setOpen(false)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1 }}>
      <input
        type="text"
        className="form-add-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHiIdx(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setHiIdx((i) => Math.min(i + 1, suggestions.length - 1))
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setHiIdx((i) => Math.max(i - 1, 0))
          } else if (e.key === "Enter") {
            e.preventDefault()
            if (showDropdown && suggestions[hiIdx]) {
              commit(suggestions[hiIdx].code)
            } else {
              commit(value.trim().toUpperCase())
            }
          } else if (e.key === "Escape") {
            setOpen(false)
          }
        }}
      />
      {showDropdown && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 50,
            borderRadius: 8,
            border: "1px solid var(--border-default)",
            background: "var(--bg-card)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
            marginTop: 2,
            overflow: "hidden",
          }}
        >
          {suggestions.map((c, i) => (
            <button
              key={c.code}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(c.code) }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                background: i === hiIdx ? "rgba(153,0,0,0.07)" : "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", letterSpacing: "0.03em" }}>
                {c.code}
              </span>
              {c.title && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: 6 }}>
                  {c.title}
                </span>
              )}
            </button>
          ))}
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

  const toggleCategory = (
    entry: Entry,
    list: Entry[],
    setList: (l: Entry[]) => void,
    cat: string
  ) => {
    const cats = entry.categories.includes(cat)
      ? entry.categories.filter((c) => c !== cat)
      : [...entry.categories, cat]
    updateEntry(list, setList, entry.id, { categories: cats })
  }

  const toApiEntry = (e: Entry): CourseInputEntry => {
    if (e.type === "course") {
      return {
        type: "course",
        code: e.code.trim().toUpperCase() || undefined,
        professor: e.professor.trim() || undefined,
        section_id: e.section_id.trim() || undefined,
      }
    }
    if (e.multiGE && e.categories.length > 0) {
      return { type: "ge", categories: e.categories }
    }
    return { type: "ge", category: e.category || undefined }
  }

  const handleSubmit = () => {
    onSubmit({
      must_haves: mustHaves.filter(entryFilled).map(toApiEntry),
      nice_to_haves: niceToHaves.filter(entryFilled).map(toApiEntry),
      constraints,
      prof_slider: profSlider,
      convenience_slider: convSlider,
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

  const addGeMust = () => {
    if (mustHaves.length >= 6) return
    const e = { ...newEntry(), type: "ge" as const }
    setMustHaves([...mustHaves, e])
    setEditingMustId(e.id)
  }

  const addGeNice = () => {
    if (niceToHaves.length >= 4) return
    const e = { ...newEntry(), type: "ge" as const }
    setNiceToHaves([...niceToHaves, e])
    setEditingNiceId(e.id)
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

  // ── discussion prompt ──────────────────────────────────────────────────────

  if (discussionPromptCourse) {
    return (
      <div className="form-step-compact mx-auto w-full max-w-[26rem] sm:max-w-[28rem] px-4 py-8">
        <div className="form-main-card p-4">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-5"
            style={{ backgroundColor: "rgba(153,0,0,0.08)", border: "1px solid rgba(153,0,0,0.15)" }}
          >
            <span className="text-2xl">🗓</span>
          </div>
          <h3
            className="text-xl text-center mb-2 font-semibold"
            style={{ fontFamily: "'DM Serif Display', serif", color: "var(--text-primary)" }}
          >
            Select a Discussion Section
          </h3>
          <p className="text-center text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
            <span className="font-semibold" style={{ color: "var(--cardinal)" }}>
              {discussionPromptCourse}
            </span>{" "}
            has multiple discussion sections. Choose the time that works best for you.
          </p>
          <div className="space-y-2">
            {discussionOptions.map((opt) => {
              const isFull = opt.seats_available === 0
              const pctRemaining = opt.total_seats > 0 ? opt.seats_available / opt.total_seats : 0
              // Seat fill gradient: white at ≥70% remaining → red at 0%
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
                  key={opt.section_id}
                  onClick={() =>
                    onDiscussionPreference({ [discussionPromptCourse]: opt.section_id })
                  }
                  className="w-full text-left px-4 py-3 rounded-xl transition-all"
                  style={{ border: `1.5px solid ${borderColor}`, backgroundColor: bgColor, color: "var(--text-primary)" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--cardinal)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = borderColor
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">
                      {opt.days.join(" / ")} · {formatTime(opt.start_time)} – {formatTime(opt.end_time)}
                    </span>
                    <span
                      className="text-xs font-semibold shrink-0"
                      style={{ color: isFull ? "var(--cardinal)" : pctRemaining < 0.3 ? "var(--cardinal)" : "var(--text-tertiary)" }}
                    >
                      {isFull ? "Full" : `${opt.seats_available} / ${opt.total_seats}`}
                    </span>
                  </div>
                  {opt.location && (
                    <p className="text-xs mt-0.5" style={{ color: "var(--text-tertiary)" }}>
                      {opt.location}
                    </p>
                  )}
                </button>
              )
            })}
            {discussionOptions.length === 0 && (
              <p className="text-center py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>
                No discussion options available.
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── main form ──────────────────────────────────────────────────────────────

  const fillUnits = ((constraints.max_units - 8) / 12) * 100

  return (
    <div className="form-step-compact mx-auto w-full max-w-[26rem] sm:max-w-[28rem] px-4 py-3 sm:py-4">

      <header className="text-center mb-3">
        <h1
          className="text-2xl sm:text-3xl font-bold mb-1 tracking-tight"
          style={{ fontFamily: "'DM Serif Display', serif", color: "var(--cardinal)" }}
        >
          Trojan Scheduler
        </h1>
        <p className="text-xs mx-auto leading-snug max-w-[24rem]" style={{ color: "var(--text-secondary)" }}>
          Build the perfect USC schedule in seconds. We balance time constraints, GE requirements, and
          RateMyProfessor scores so you don&apos;t have to.
        </p>
        <p className="text-[11px] mt-1.5 font-medium tracking-wide" style={{ color: "var(--text-tertiary)" }}>
          Step 1 of 3 · Preferences
        </p>
      </header>

      {error && (
        <div
          className="mb-2 px-3 py-2 rounded-lg text-xs"
          style={{ backgroundColor: "rgba(153,0,0,0.06)", border: "1px solid rgba(153,0,0,0.20)", color: "var(--cardinal)" }}
        >
          {error}
        </div>
      )}

      <div className="form-main-card p-4 space-y-0">

        {/* Required courses */}
        <section className="pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <h2 className="text-[13px] font-bold tracking-tight" style={{ color: "var(--text-primary)", fontFamily: "Inter, sans-serif" }}>
              Required courses
            </h2>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
              {mustHaves.length}/6
            </span>
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
            onAddGe={addGeMust}
            updateEntry={updateEntry}
            removeEntry={(list, setList, id) =>
              deleteEntryAndClearEdit(list, setList, id, setEditingMustId, editingMustId)
            }
            toggleCategory={toggleCategory}
          />
        </section>

        <div className="h-px w-full" style={{ backgroundColor: "var(--border-subtle)" }} />

        {/* Optional courses */}
        <section className="py-3">
          <div className="flex items-center justify-between mb-1.5">
            <h2 className="text-[13px] font-bold tracking-tight" style={{ color: "var(--text-primary)", fontFamily: "Inter, sans-serif" }}>
              Optional courses
            </h2>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
              {niceToHaves.length}/4
            </span>
          </div>
          {niceToHaves.filter(entryFilled).length === 0 &&
            !niceToHaves.some((e) => !entryFilled(e)) &&
            editingNiceId === null && (
            <p className="text-xs italic mb-1.5" style={{ color: "var(--text-tertiary)" }}>
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
            onAddGe={addGeNice}
            updateEntry={updateEntry}
            removeEntry={(list, setList, id) =>
              deleteEntryAndClearEdit(list, setList, id, setEditingNiceId, editingNiceId)
            }
            toggleCategory={toggleCategory}
          />
        </section>

        <div className="h-px w-full my-0" style={{ backgroundColor: "var(--border-subtle)" }} />

        {/* Hard constraints */}
        <section className="pt-3 space-y-2">
          <h2 className="text-[13px] font-bold tracking-tight mb-0.5" style={{ color: "var(--text-primary)", fontFamily: "Inter, sans-serif" }}>
            Class window
          </h2>

          <div className="pt-0.5">
            <DualTimeRangeSlider
              earliestIdx={earliestIdx}
              latestIdx={latestIdx}
              onChange={applyTimeRangeIndices}
            />
            <div className="flex justify-between mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              <span>Earliest start</span>
              <span>Latest end</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>Max units</span>
              <span className="text-xs font-bold tabular-nums" style={{ color: "var(--cardinal)" }}>
                {constraints.max_units}
              </span>
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
            <div className="flex justify-between text-[11px] mt-0.5 leading-none" style={{ color: "var(--text-tertiary)" }}>
              <span>8</span>
              <span>20</span>
            </div>
          </div>

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
              <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Days off</p>
              <p className="text-[11px] mt-0 leading-snug" style={{ color: "var(--text-tertiary)" }}>
                Pick days you want completely free
              </p>
            </div>
            <div
              className="toggle shrink-0 pointer-events-none"
              style={{ backgroundColor: showDaysOff ? "var(--cardinal)" : "var(--border-default)" }}
            >
              <div className="toggle-thumb" style={{ transform: showDaysOff ? "translateX(18px)" : "translateX(0)" }} />
            </div>
          </div>
          {showDaysOff && (
            <div className="-mt-1 mb-0.5" onClick={(e) => e.stopPropagation()}>
              <select
                value={constraints.days_off[0] ?? ""}
                onChange={(e) =>
                  setConstraints((c) => ({ ...c, days_off: e.target.value ? [e.target.value] : [] }))
                }
              >
                <option value="">Select a day…</option>
                {[
                  { value: "Mon", label: "Monday" },
                  { value: "Tue", label: "Tuesday" },
                  { value: "Wed", label: "Wednesday" },
                  { value: "Thu", label: "Thursday" },
                  { value: "Fri", label: "Friday" },
                ].map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
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
              <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>No back-to-back</p>
              <p className="text-[11px] mt-0 leading-snug" style={{ color: "var(--text-tertiary)" }}>
                Require gaps between classes
              </p>
            </div>
            <div
              className="toggle shrink-0 pointer-events-none"
              style={{ backgroundColor: constraints.no_back_to_back ? "var(--cardinal)" : "var(--border-default)" }}
            >
              <div className="toggle-thumb" style={{ transform: constraints.no_back_to_back ? "translateX(18px)" : "translateX(0)" }} />
            </div>
          </div>
        </section>

        <div className="h-px w-full" style={{ backgroundColor: "var(--border-subtle)" }} />

        <section className="pt-1">
          <button
            type="button"
            className="form-disclosure-btn"
            onClick={() => setRankingsOpen((o) => !o)}
            aria-expanded={rankingsOpen}
          >
            <span>Fine-tune rankings</span>
            <span className={`form-disclosure-chevron ${rankingsOpen ? "is-open" : ""}`} aria-hidden>
              <ChevronDownIcon />
            </span>
          </button>
          {rankingsOpen && (
            <div className="space-y-2 pt-1 pb-1">
              <SliderRow
                label="Professor Quality"
                hint="Prioritizes sections with higher RateMyProfessor scores"
                value={profSlider}
                onChange={setProfSlider}
                leftLabel="Less important"
                rightLabel="Top priority"
              />
              <div className="h-px w-full my-0.5" style={{ backgroundColor: "var(--border-subtle)" }} />
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

      <button type="button" onClick={handleSubmit} className="btn-primary w-full py-2.5 text-sm mt-3 gap-2 rounded-xl">
        <SparkleIcon />
        Build My Schedule
      </button>
    </div>
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
    background: "#d4d4d4",
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
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold tabular-nums" style={{ color: "var(--cardinal)" }}>
          {startLabel}
        </span>
        <span className="text-xs font-bold tabular-nums" style={{ color: "var(--cardinal)" }}>
          {endLabel}
        </span>
      </div>
      <div
        ref={trackRef}
        className="dual-range-track"
        style={{
          position: "relative",
          width: "100%",
          minHeight: 20,
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
  onAddGe,
  updateEntry,
  removeEntry,
  toggleCategory,
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
  onAddGe: () => void
  updateEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number, patch: Partial<Entry>) => void
  removeEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number) => void
  toggleCategory: (entry: Entry, list: Entry[], setList: (l: Entry[]) => void, cat: string) => void
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
                style={{ color: "inherit", fontFamily: "inherit", fontSize: "inherit", fontWeight: "inherit" }}
                onClick={() => setEditingId(editingId === e.id ? null : e.id)}
              >
                {pillLabel(e)}
              </button>
              <button
                type="button"
                className="form-pill-remove"
                aria-label={`Remove ${pillLabel(e)}`}
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
        <div className="rounded-lg p-2.5 border space-y-2" style={{ borderColor: "var(--border-default)", background: "var(--bg-subtle)" }}>
          {editingId !== null && entries.find((x) => x.id === editingId) && (
            <EntryEditor
              entry={entries.find((x) => x.id === editingId)!}
              list={entries}
              setList={setEntries}
              updateEntry={updateEntry}
              removeEntry={removeEntry}
              toggleCategory={toggleCategory}
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
                toggleCategory={toggleCategory}
              />
            ))}
        </div>
      )}

      {!atCap && (
        <div className="form-add-row">
          <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}>
            <BookIcon />
          </span>
          <AutocompleteInput
            value={draft}
            onChange={setDraft}
            onCommit={onCommitCode}
            placeholder={draftPlaceholder}
          />
          <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}>
            <ChevronsIcon />
          </span>
        </div>
      )}

      {!atCap && (
        <button
          type="button"
          className="text-[11px] font-medium hover:underline leading-none"
          style={{ color: "var(--cardinal)" }}
          onClick={onAddGe}
        >
          + Add GE requirement
        </button>
      )}
    </div>
  )
}

function EntryEditor({
  entry,
  list,
  setList,
  updateEntry,
  removeEntry,
  toggleCategory,
}: {
  entry: Entry
  list: Entry[]
  setList: (l: Entry[]) => void
  updateEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number, patch: Partial<Entry>) => void
  removeEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number) => void
  toggleCategory: (entry: Entry, list: Entry[], setList: (l: Entry[]) => void, cat: string) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
          Edit entry
        </span>
        <button
          type="button"
          className="text-[11px] font-medium"
          style={{ color: "var(--cardinal)" }}
          onClick={() => removeEntry(list, setList, entry.id)}
        >
          Remove
        </button>
      </div>

      {entry.type === "course" && (
        <input
          type="text"
          value={entry.code}
          onChange={(e) => updateEntry(list, setList, entry.id, { code: e.target.value })}
          placeholder="Course code"
          style={{
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        />
      )}

      <div
        className="inline-flex rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border-default)" }}
      >
        <button
          type="button"
          onClick={() => updateEntry(list, setList, entry.id, { type: "course" })}
            className="px-2 py-1 text-[11px] font-medium transition-colors"
              style={{
                backgroundColor: entry.type === "course" ? "var(--cardinal)" : "white",
                color: entry.type === "course" ? "white" : "var(--text-secondary)",
              }}
            >
              Course
            </button>
            <button
              type="button"
              onClick={() => updateEntry(list, setList, entry.id, { type: "ge" })}
              className="px-2 py-1 text-[11px] font-medium transition-colors"
          style={{
            backgroundColor: entry.type === "ge" ? "rgba(255,204,0,0.20)" : "white",
            color: entry.type === "ge" ? "#8A6D00" : "var(--text-secondary)",
          }}
        >
          GE Requirement
        </button>
      </div>

      {entry.type === "course" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(["professor", "section_id"] as const).map((field) => (
            <input
              key={field}
              value={entry[field]}
              onChange={(e) => updateEntry(list, setList, entry.id, { [field]: e.target.value })}
              placeholder={field === "professor" ? "Professor (optional)" : "Section ID (optional)"}
            />
          ))}
        </div>
      )}

      {entry.type === "ge" && (
        <div className="space-y-2">
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() =>
              updateEntry(list, setList, entry.id, { multiGE: !entry.multiGE, categories: [], category: "" })
            }
          >
            <div
              className="toggle"
              style={{
                width: "32px",
                height: "17px",
                backgroundColor: entry.multiGE ? "rgba(184,150,12,0.7)" : "var(--border-default)",
              }}
            >
              <div
                className="toggle-thumb"
                style={{
                  width: "13px",
                  height: "13px",
                  transform: entry.multiGE ? "translateX(15px)" : "translateX(0)",
                }}
              />
            </div>
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {entry.multiGE ? "Double-count (2+ categories)" : "Single GE category"}
            </span>
          </label>

          {entry.multiGE ? (
            <div className="flex flex-wrap gap-1.5">
              {GE_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(entry, list, setList, cat)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    backgroundColor: entry.categories.includes(cat) ? "rgba(255,204,0,0.20)" : "white",
                    border: entry.categories.includes(cat)
                      ? "1.5px solid rgba(184,150,12,0.50)"
                      : "1.5px solid var(--border-default)",
                    color: entry.categories.includes(cat) ? "#8A6D00" : "var(--text-secondary)",
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
          ) : (
            <select
              value={entry.category}
              onChange={(e) => updateEntry(list, setList, entry.id, { category: e.target.value })}
            >
              <option value="">Select GE category…</option>
              {GE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  Category {c}
                </option>
              ))}
            </select>
          )}
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
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{label}</span>
        <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: "var(--cardinal)" }}>
          {Math.round(value * 100)}%
        </span>
      </div>
      <p className="text-[11px] mb-1 leading-snug" style={{ color: "var(--text-tertiary)" }}>{hint}</p>
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
      <div className="flex justify-between text-[11px] mt-0.5 leading-none" style={{ color: "var(--text-tertiary)" }}>
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

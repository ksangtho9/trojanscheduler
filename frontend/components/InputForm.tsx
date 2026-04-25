"use client"

import { useState } from "react"
import {
  Constraints,
  CourseInputEntry,
  DiscussionOption,
  GenerateRequest,
  Modality,
} from "@/lib/types"

const GE_CATEGORIES = ["A", "B", "C", "D", "E", "F", "G"]

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

export default function InputForm({
  onSubmit,
  error,
  discussionPromptCourse,
  discussionOptions,
  onDiscussionPreference,
}: Props) {
  const [mustHaves, setMustHaves] = useState<Entry[]>([newEntry()])
  const [niceToHaves, setNiceToHaves] = useState<Entry[]>([])
  const [constraints, setConstraints] = useState<Constraints>(DEFAULT_CONSTRAINTS)
  const [profSlider, setProfSlider] = useState(0.5)
  const [convSlider, setConvSlider] = useState(0.5)
  const [showDaysOff, setShowDaysOff] = useState(false)

  const updateEntry = (
    list: Entry[],
    setList: (l: Entry[]) => void,
    id: number,
    patch: Partial<Entry>
  ) => setList(list.map((e) => (e.id === id ? { ...e, ...patch } : e)))

  const removeEntry = (
    list: Entry[],
    setList: (l: Entry[]) => void,
    id: number
  ) => setList(list.filter((e) => e.id !== id))

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
      must_haves: mustHaves
        .filter((e) => e.code || e.category || e.categories.length)
        .map(toApiEntry),
      nice_to_haves: niceToHaves
        .filter((e) => e.code || e.category || e.categories.length)
        .map(toApiEntry),
      constraints,
      prof_slider: profSlider,
      convenience_slider: convSlider,
    })
  }

  // ── discussion prompt ──────────────────────────────────────────────────────

  if (discussionPromptCourse) {
    return (
      <div className="max-w-lg mx-auto px-5 py-16">
        <div className="card p-8">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-5"
            style={{ backgroundColor: "rgba(153,0,0,0.08)", border: "1px solid rgba(153,0,0,0.15)" }}
          >
            <span className="text-2xl">🗓</span>
          </div>
          <h3
            className="text-xl text-center mb-2"
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
            {discussionOptions.map((opt) => (
              <button
                key={opt.section_id}
                onClick={() =>
                  onDiscussionPreference({ [discussionPromptCourse]: opt.section_id })
                }
                className="w-full text-left px-4 py-3 rounded-xl transition-all"
                style={{ border: "1.5px solid var(--border-default)", backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--cardinal)"
                  e.currentTarget.style.backgroundColor = "rgba(153,0,0,0.03)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-default)"
                  e.currentTarget.style.backgroundColor = "var(--bg-card)"
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">
                    {opt.days.join(" / ")} · {formatTime(opt.start_time)} – {formatTime(opt.end_time)}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                    {opt.seats_available} seats
                  </span>
                </div>
                {opt.location && (
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-tertiary)" }}>
                    {opt.location}
                  </p>
                )}
              </button>
            ))}
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

  return (
    <div className="max-w-2xl mx-auto px-5 py-10">

      {/* Hero */}
      <div className="mb-8">
        <h1
          className="text-5xl mb-2"
          style={{ fontFamily: "'DM Serif Display', serif", color: "var(--cardinal)" }}
        >
          Trojan Scheduler
        </h1>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Build the perfect USC schedule in seconds — balanced by time, professor ratings, and GE requirements.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="mb-5 px-4 py-3 rounded-xl text-sm"
          style={{ backgroundColor: "rgba(153,0,0,0.06)", border: "1px solid rgba(153,0,0,0.20)", color: "var(--cardinal)" }}
        >
          {error}
        </div>
      )}

      <div className="space-y-5">

        {/* Required Courses */}
        <FormSection title="Required Courses" count={`${mustHaves.length}/6`}>
          {mustHaves.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              list={mustHaves}
              setList={setMustHaves}
              placeholder="e.g. CSCI 270"
              updateEntry={updateEntry}
              removeEntry={removeEntry}
              toggleCategory={toggleCategory}
            />
          ))}
          {mustHaves.length < 6 && (
            <AddButton onClick={() => setMustHaves([...mustHaves, newEntry()])} />
          )}
        </FormSection>

        {/* Preferred Courses */}
        <FormSection title="Preferred Courses" count={`${niceToHaves.length}/4`}>
          {niceToHaves.length === 0 && (
            <p className="text-xs mb-3 italic" style={{ color: "var(--text-tertiary)" }}>
              No entries yet — these are added only when your schedule allows.
            </p>
          )}
          {niceToHaves.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              list={niceToHaves}
              setList={setNiceToHaves}
              placeholder="e.g. HIST 105"
              updateEntry={updateEntry}
              removeEntry={removeEntry}
              toggleCategory={toggleCategory}
            />
          ))}
          {niceToHaves.length < 4 && (
            <AddButton onClick={() => setNiceToHaves([...niceToHaves, newEntry()])} />
          )}
        </FormSection>

        {/* Ranking Preferences */}
        <FormSection title="Ranking Preferences">
          <div className="space-y-5">
            <SliderRow
              label="Professor Quality"
              hint="Prioritizes sections with higher RateMyProfessor scores"
              value={profSlider}
              onChange={setProfSlider}
              leftLabel="Less important"
              rightLabel="Top priority"
            />
            <div className="h-px w-full" style={{ backgroundColor: "var(--border-subtle)" }} />
            <SliderRow
              label="Schedule Convenience"
              hint="Prioritizes fewer campus days and less time between classes"
              value={convSlider}
              onChange={setConvSlider}
              leftLabel="Less important"
              rightLabel="Top priority"
            />
          </div>
        </FormSection>

        {/* Scheduling Constraints */}
        <FormSection title="Scheduling Constraints">

          {/* Time window */}
          <div className="grid grid-cols-2 gap-3 mb-5">
            <label className="block">
              <span className="text-xs font-medium mb-1.5 block" style={{ color: "var(--text-secondary)" }}>
                Earliest start
              </span>
              <input
                type="time"
                value={constraints.earliest_start}
                onChange={(e) => setConstraints((c) => ({ ...c, earliest_start: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium mb-1.5 block" style={{ color: "var(--text-secondary)" }}>
                Latest end
              </span>
              <input
                type="time"
                value={constraints.latest_end}
                onChange={(e) => setConstraints((c) => ({ ...c, latest_end: e.target.value }))}
              />
            </label>
          </div>

          {/* Campus-free day */}
          <div className="mb-4">
            <div
              className="flex items-center justify-between cursor-pointer py-3 px-4 rounded-xl transition-all"
              style={{
                backgroundColor: showDaysOff ? "rgba(153,0,0,0.04)" : "var(--bg-subtle)",
                border: `1.5px solid ${showDaysOff ? "rgba(153,0,0,0.20)" : "var(--border-subtle)"}`,
              }}
              onClick={() => {
                setShowDaysOff(!showDaysOff)
                if (showDaysOff) setConstraints((c) => ({ ...c, days_off: [] }))
              }}
            >
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  Campus-Free Day
                </p>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  Reserve a weekday with no in-person classes
                </p>
              </div>
              <div
                className="toggle shrink-0"
                style={{ backgroundColor: showDaysOff ? "var(--cardinal)" : "var(--border-default)" }}
              >
                <div className="toggle-thumb" style={{ transform: showDaysOff ? "translateX(18px)" : "translateX(0)" }} />
              </div>
            </div>
            {showDaysOff && (
              <div className="mt-2">
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
          </div>

          {/* Max units + no back-to-back */}
          <div className="grid grid-cols-2 gap-3">
            <div
              className="px-4 py-3 rounded-xl"
              style={{ backgroundColor: "var(--bg-subtle)", border: "1.5px solid var(--border-subtle)" }}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Max units</span>
                <span className="text-sm font-bold" style={{ color: "var(--cardinal)" }}>{constraints.max_units}</span>
              </div>
              <input
                type="range"
                min={8}
                max={20}
                value={constraints.max_units}
                onChange={(e) => setConstraints((c) => ({ ...c, max_units: Number(e.target.value) }))}
              />
              <div className="flex justify-between text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                <span>8</span><span>20</span>
              </div>
            </div>

            <div
              className="px-4 py-3 rounded-xl flex items-center justify-between cursor-pointer"
              style={{
                backgroundColor: constraints.no_back_to_back ? "rgba(153,0,0,0.04)" : "var(--bg-subtle)",
                border: `1.5px solid ${constraints.no_back_to_back ? "rgba(153,0,0,0.20)" : "var(--border-subtle)"}`,
              }}
              onClick={() => setConstraints((c) => ({ ...c, no_back_to_back: !c.no_back_to_back }))}
            >
              <div>
                <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>No back-to-back</p>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Require gaps between classes</p>
              </div>
              <div
                className="toggle shrink-0"
                style={{ backgroundColor: constraints.no_back_to_back ? "var(--cardinal)" : "var(--border-default)" }}
              >
                <div className="toggle-thumb" style={{ transform: constraints.no_back_to_back ? "translateX(18px)" : "translateX(0)" }} />
              </div>
            </div>
          </div>

          {/* Modality — kept in data model, hidden from UI for now */}

        </FormSection>

        {/* Submit */}
        <button onClick={handleSubmit} className="btn-primary w-full py-4 text-base">
          Build My Schedule →
        </button>

      </div>
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────

function formatTime(t: string): string {
  const [h, m] = t.split(":").map(Number)
  const ampm = h >= 12 ? "pm" : "am"
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${hour}:${m.toString().padStart(2, "0")}${ampm}`
}

function EntryRow({
  entry, list, setList, placeholder, updateEntry, removeEntry, toggleCategory,
}: {
  entry: Entry
  list: Entry[]
  setList: (l: Entry[]) => void
  placeholder: string
  updateEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number, patch: Partial<Entry>) => void
  removeEntry: (list: Entry[], setList: (l: Entry[]) => void, id: number) => void
  toggleCategory: (entry: Entry, list: Entry[], setList: (l: Entry[]) => void, cat: string) => void
}) {
  return (
    <div
      className="mb-3 rounded-xl p-4"
      style={{
        backgroundColor: "#FAFAFA",
        border: "1px solid var(--border-subtle)",
        borderLeft: "3px solid var(--cardinal)",
      }}
    >
      {/* Code input + remove */}
      <div className="flex items-center gap-2 mb-2">
        <input
          value={entry.code}
          onChange={(e) => updateEntry(list, setList, entry.id, { code: e.target.value })}
          onFocus={() => updateEntry(list, setList, entry.id, { expanded: true })}
          placeholder={placeholder}
          style={{
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            border: "1.5px solid var(--border-default)",
            borderRadius: "8px",
            padding: "8px 12px",
            fontSize: "14px",
            width: "100%",
            backgroundColor: "white",
            color: "var(--text-primary)",
            fontFamily: "'Inter', sans-serif",
            boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
          }}
        />
        <button
          onClick={() => removeEntry(list, setList, entry.id)}
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors text-lg leading-none"
          style={{ color: "var(--text-tertiary)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(153,0,0,0.08)"
            e.currentTarget.style.color = "var(--cardinal)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent"
            e.currentTarget.style.color = "var(--text-tertiary)"
          }}
        >
          ×
        </button>
      </div>

      {/* Expanded fields */}
      {entry.expanded && (
        <>
          {/* Type toggle */}
          <div
            className="inline-flex rounded-lg overflow-hidden mb-3"
            style={{ border: "1px solid var(--border-default)" }}
          >
            <button
              onClick={() => updateEntry(list, setList, entry.id, { type: "course" })}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                backgroundColor: entry.type === "course" ? "var(--cardinal)" : "white",
                color: entry.type === "course" ? "white" : "var(--text-secondary)",
              }}
            >
              Course
            </button>
            <button
              onClick={() => updateEntry(list, setList, entry.id, { type: "ge" })}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                backgroundColor: entry.type === "ge" ? "rgba(255,204,0,0.20)" : "white",
                color: entry.type === "ge" ? "#8A6D00" : "var(--text-secondary)",
              }}
            >
              GE Requirement
            </button>
          </div>

          {/* Course extras */}
          {entry.type === "course" && (
            <div className="grid grid-cols-2 gap-2">
              {["professor", "section_id"].map((field) => (
                <input
                  key={field}
                  value={entry[field as keyof Entry] as string}
                  onChange={(e) => updateEntry(list, setList, entry.id, { [field]: e.target.value })}
                  placeholder={field === "professor" ? "Professor (optional)" : "Section ID (optional)"}
                  style={{
                    border: "1.5px solid var(--border-default)",
                    borderRadius: "8px",
                    padding: "7px 12px",
                    fontSize: "13px",
                    backgroundColor: "white",
                    color: "var(--text-primary)",
                    fontFamily: "'Inter', sans-serif",
                    width: "100%",
                  }}
                />
              ))}
            </div>
          )}

          {/* GE extras */}
          {entry.type === "ge" && (
            <div className="space-y-2">
              <label
                className="flex items-center gap-2 cursor-pointer select-none"
                onClick={() => updateEntry(list, setList, entry.id, { multiGE: !entry.multiGE, categories: [], category: "" })}
              >
                <div
                  className="toggle"
                  style={{ width: "32px", height: "17px", backgroundColor: entry.multiGE ? "rgba(184,150,12,0.7)" : "var(--border-default)" }}
                >
                  <div className="toggle-thumb" style={{ width: "13px", height: "13px", transform: entry.multiGE ? "translateX(15px)" : "translateX(0)" }} />
                </div>
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {entry.multiGE ? "Double-count (2+ categories)" : "Single GE category"}
                </span>
              </label>

              {entry.multiGE ? (
                <div className="flex flex-wrap gap-1.5">
                  {GE_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => toggleCategory(entry, list, setList, cat)}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
                      style={{
                        backgroundColor: entry.categories.includes(cat) ? "rgba(255,204,0,0.20)" : "white",
                        border: entry.categories.includes(cat) ? "1.5px solid rgba(184,150,12,0.50)" : "1.5px solid var(--border-default)",
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
                    <option key={c} value={c}>Category {c}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FormSection({ title, count, children }: { title: string; count?: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-sm tracking-tight" style={{ color: "var(--text-primary)" }}>
          {title}
        </h3>
        {count && <span className="text-xs font-mono" style={{ color: "var(--text-tertiary)" }}>{count}</span>}
      </div>
      {children}
    </div>
  )
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs transition-opacity mt-2"
      style={{ color: "var(--cardinal)" }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.7")}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
    >
      <span className="text-base leading-none">+</span> Add entry
    </button>
  )
}

function SliderRow({ label, hint, value, onChange, leftLabel, rightLabel }: {
  label: string; hint: string; value: number; onChange: (v: number) => void; leftLabel: string; rightLabel: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</span>
        <span className="text-xs font-mono font-bold" style={{ color: "var(--cardinal)" }}>
          {Math.round(value * 100)}%
        </span>
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--text-tertiary)" }}>{hint}</p>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="flex justify-between text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
        <span>{leftLabel}</span><span>{rightLabel}</span>
      </div>
    </div>
  )
}
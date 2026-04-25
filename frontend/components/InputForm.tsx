// Stage 1: input form
// Must-Have section (up to 6): course chip input + GE category picker
// Nice-to-Have section (up to 4): same inputs
// Hard Constraints: time sliders, days-off toggles, units slider, back-to-back toggle, modality radio
// "Build My Schedule" CTA — cardinal #990000
"use client"

import { useState, useEffect } from "react"
import {
  Constraints,
  CourseInputEntry,
  DiscussionSectionOption,
  DiscussionSectionPref,
  GenerateRequest,
  Modality,
} from "@/lib/types"

const GE_CATEGORIES = ["A", "B", "C", "D", "E", "F", "G"]
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]

interface Entry {
  id: number
  type: "course" | "ge"
  code: string
  professor: string
  section_id: string
  category: string
  categories: string[]
  multiGE: boolean
}

interface Props {
  onSubmit: (payload: GenerateRequest) => void
  error: string | null
  discussionPromptCourse: { course_code: string; options: DiscussionSectionOption[] } | null
  onDiscussionPreference: (pref: Record<string, DiscussionSectionPref>) => void
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
  onDiscussionPreference,
}: Props) {
  const [mustHaves, setMustHaves] = useState<Entry[]>([newEntry()])
  const [niceToHaves, setNiceToHaves] = useState<Entry[]>([])
  const [constraints, setConstraints] = useState<Constraints>(DEFAULT_CONSTRAINTS)
  const [profSlider, setProfSlider] = useState(0.5)
  const [convSlider, setConvSlider] = useState(0.5)
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedSectionId(null)
  }, [discussionPromptCourse])

  // ── entry helpers ──────────────────────────────────────────────────────────

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

  // ── serialization ──────────────────────────────────────────────────────────

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

  const handleDiscussionSubmit = () => {
    if (!discussionPromptCourse || !selectedSectionId) return
    const selected = discussionPromptCourse.options.find(
      (o) => o.section_id === selectedSectionId
    )
    if (!selected) return
    onDiscussionPreference({
      [discussionPromptCourse.course_code]: {
        section_id: selected.section_id,
        start_time: selected.start_time,
        end_time: selected.end_time,
        days: selected.days,
      },
    })
  }

  // ── discussion prompt screen ───────────────────────────────────────────────

  if (discussionPromptCourse) {
    return (
      <div className="max-w-md mx-auto px-5 py-16">
        <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-8">
          <div className="w-12 h-12 rounded-xl bg-[#990000]/20 border border-[#990000]/30 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">🗓</span>
          </div>
          <h3 className="text-white font-bold text-lg mb-1 text-center">
            Pick a Discussion Section
          </h3>
          <p className="text-white/40 text-sm mb-6 text-center">
            <span className="text-white/70 font-medium">{discussionPromptCourse.course_code}</span>{" "}
            has multiple discussion sections. Pick one.
          </p>
          <div className="flex flex-col gap-2 mb-6">
            {discussionPromptCourse.options.map((opt) => {
              const full = opt.seats_available === 0
              const tight = !full && opt.seats_available <= 5
              const seatColor = full
                ? "text-red-400"
                : tight
                ? "text-yellow-400"
                : "text-green-400"
              const borderColor = full
                ? "border-red-500/40"
                : tight
                ? "border-yellow-500/40"
                : "border-white/10"
              const selected = selectedSectionId === opt.section_id
              return (
                <button
                  key={opt.section_id}
                  onClick={() => setSelectedSectionId(opt.section_id)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                    selected
                      ? "bg-[#990000]/20 border-[#990000] "
                      : `bg-white/[0.03] ${borderColor} hover:border-white/25`
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-white text-sm font-semibold">
                        {opt.days.join(" / ")}{" "}
                        <span className="font-normal text-white/60">
                          {fmt12(opt.start_time)} – {fmt12(opt.end_time)}
                        </span>
                      </div>
                      <div className="text-white/35 text-xs mt-0.5 truncate">
                        {opt.section_type.charAt(0).toUpperCase() + opt.section_type.slice(1)}{" "}
                        · {opt.location || "TBA"}
                      </div>
                    </div>
                    <div className={`text-xs font-semibold shrink-0 ${seatColor}`}>
                      {full
                        ? "Full"
                        : `${opt.seats_available}/${opt.total_seats}`}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
          <button
            onClick={handleDiscussionSubmit}
            disabled={!selectedSectionId}
            className="w-full bg-[#990000] hover:bg-[#b30000] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Continue Building Schedule
          </button>
        </div>
      </div>
    )
  }

  // ── main form ──────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto px-5 py-12">

      {/* Hero */}
      <div className="mb-10">
        <p className="text-[#990000] text-xs font-mono tracking-widest uppercase mb-3">
          Step 1 of 3
        </p>
        <h1 className="text-4xl font-black tracking-tight text-white mb-2 leading-tight">
          Build Your<br />
          <span className="text-[#990000]">Perfect Schedule.</span>
        </h1>
        <p className="text-white/35 text-sm">
          Ranked by RateMyProfessor scores, compactness, and time efficiency.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-5">

        {/* Must-Haves */}
        <FormSection title="Must-Have Courses" subtitle="Up to 6 — required in every schedule">
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

        {/* Nice-to-Haves */}
        <FormSection title="Nice-to-Have Courses" subtitle="Up to 4 — added if they fit">
          {niceToHaves.length === 0 && (
            <p className="text-white/25 text-xs mb-3">
              None added — these are optional.
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

        {/* Priorities */}
        <FormSection title="Your Priorities">
          <div className="space-y-5">
            <SliderRow
              label="Professor Quality"
              hint="Weights RateMyProfessor scores higher when ranking schedules"
              value={profSlider}
              onChange={setProfSlider}
              leftLabel="Less important"
              rightLabel="Top priority"
            />
            <SliderRow
              label="Schedule Convenience"
              hint="Fewer campus days and less dead time between classes"
              value={convSlider}
              onChange={setConvSlider}
              leftLabel="Less important"
              rightLabel="Top priority"
            />
          </div>
        </FormSection>

        {/* Constraints */}
        <FormSection title="Hard Constraints">

          {/* Time window */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className="text-white/40 text-xs mb-1.5 block">Earliest start</span>
              <input
                type="time"
                value={constraints.earliest_start}
                onChange={(e) =>
                  setConstraints((c) => ({ ...c, earliest_start: e.target.value }))
                }
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-white/25"
              />
            </label>
            <label className="block">
              <span className="text-white/40 text-xs mb-1.5 block">Latest end</span>
              <input
                type="time"
                value={constraints.latest_end}
                onChange={(e) =>
                  setConstraints((c) => ({ ...c, latest_end: e.target.value }))
                }
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-white/25"
              />
            </label>
          </div>

          {/* Days off */}
          <div className="mb-4">
            <span className="text-white/40 text-xs mb-2 block">Days off campus</span>
            <div className="flex gap-2">
              {DAYS.map((day) => (
                <button
                  key={day}
                  onClick={() =>
                    setConstraints((c) => ({
                      ...c,
                      days_off: c.days_off.includes(day)
                        ? c.days_off.filter((d) => d !== day)
                        : [...c.days_off, day],
                    }))
                  }
                  className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-all ${
                    constraints.days_off.includes(day)
                      ? "bg-[#990000] border-[#990000] text-white"
                      : "bg-white/5 border-white/10 text-white/40 hover:border-white/20"
                  }`}
                >
                  {day}
                </button>
              ))}
            </div>
          </div>

          {/* Max units */}
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-white/40 text-xs">Max units</span>
              <span className="text-white font-bold text-sm">{constraints.max_units}</span>
            </div>
            <input
              type="range"
              min={8}
              max={20}
              value={constraints.max_units}
              onChange={(e) =>
                setConstraints((c) => ({ ...c, max_units: Number(e.target.value) }))
              }
              className="w-full accent-[#990000]"
            />
            <div className="flex justify-between text-white/20 text-xs mt-1">
              <span>8</span>
              <span>20</span>
            </div>
          </div>

          {/* No back-to-back toggle */}
          <label
            className="flex items-center gap-3 mb-4 cursor-pointer select-none"
            onClick={() =>
              setConstraints((c) => ({ ...c, no_back_to_back: !c.no_back_to_back }))
            }
          >
            <div
              className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                constraints.no_back_to_back ? "bg-[#990000]" : "bg-white/15"
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                  constraints.no_back_to_back ? "left-5" : "left-0.5"
                }`}
              />
            </div>
            <span className="text-white/60 text-sm">No back-to-back classes</span>
          </label>

          {/* Modality */}
          <div>
            <span className="text-white/40 text-xs mb-2 block">Modality</span>
            <div className="flex gap-2">
              {(["in_person", "online", "no_preference"] as Modality[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setConstraints((c) => ({ ...c, modality: m }))}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                    constraints.modality === m
                      ? "bg-white/12 border-white/25 text-white"
                      : "bg-white/5 border-white/10 text-white/40 hover:border-white/20"
                  }`}
                >
                  {m === "in_person" ? "In Person" : m === "online" ? "Online" : "Any"}
                </button>
              ))}
            </div>
          </div>
        </FormSection>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          className="w-full bg-[#990000] hover:bg-[#b30000] active:scale-[0.99] text-white font-bold py-4 rounded-xl transition-all text-base tracking-wide shadow-lg shadow-[#990000]/20"
        >
          Build My Schedule →
        </button>

      </div>
    </div>
  )
}

// ── shared sub-components ────────────────────────────────────────────────────

function EntryRow({
  entry,
  list,
  setList,
  placeholder,
  updateEntry,
  removeEntry,
  toggleCategory,
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
    <div className="mb-3 bg-white/[0.03] border border-white/[0.07] rounded-xl p-3">

      {/* Type toggle + remove */}
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex rounded-lg border border-white/10 overflow-hidden text-xs shrink-0">
          <button
            onClick={() => updateEntry(list, setList, entry.id, { type: "course" })}
            className={`px-3 py-1.5 font-medium transition-colors ${
              entry.type === "course"
                ? "bg-white/10 text-white"
                : "text-white/35 hover:text-white/60"
            }`}
          >
            Course
          </button>
          <button
            onClick={() => updateEntry(list, setList, entry.id, { type: "ge" })}
            className={`px-3 py-1.5 font-medium transition-colors ${
              entry.type === "ge"
                ? "bg-[#FFCC00]/15 text-[#FFCC00]"
                : "text-white/35 hover:text-white/60"
            }`}
          >
            GE
          </button>
        </div>
        <button
          onClick={() => removeEntry(list, setList, entry.id)}
          className="ml-auto text-white/20 hover:text-white/50 transition-colors text-xl leading-none"
        >
          ×
        </button>
      </div>

      {/* Course mode */}
      {entry.type === "course" && (
        <div className="space-y-2">
          <input
            value={entry.code}
            onChange={(e) =>
              updateEntry(list, setList, entry.id, { code: e.target.value })
            }
            placeholder={placeholder}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-white/25 uppercase tracking-wide"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={entry.professor}
              onChange={(e) =>
                updateEntry(list, setList, entry.id, { professor: e.target.value })
              }
              placeholder="Professor (optional)"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-xs placeholder-white/20 focus:outline-none focus:border-white/25"
            />
            <input
              value={entry.section_id}
              onChange={(e) =>
                updateEntry(list, setList, entry.id, { section_id: e.target.value })
              }
              placeholder="Section ID (optional)"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-xs placeholder-white/20 focus:outline-none focus:border-white/25"
            />
          </div>
        </div>
      )}

      {/* GE mode */}
      {entry.type === "ge" && (
        <div className="space-y-2">
          {/* Multi-GE toggle */}
          <label
            className="flex items-center gap-2 cursor-pointer mb-1 select-none"
            onClick={() =>
              updateEntry(list, setList, entry.id, {
                multiGE: !entry.multiGE,
                categories: [],
                category: "",
              })
            }
          >
            <div
              className={`w-8 h-4 rounded-full transition-colors relative shrink-0 ${
                entry.multiGE ? "bg-[#FFCC00]/60" : "bg-white/15"
              }`}
            >
              <span
                className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-all ${
                  entry.multiGE ? "left-4" : "left-0.5"
                }`}
              />
            </div>
            <span className="text-white/40 text-xs">
              {entry.multiGE
                ? "Double-count mode (pick 2+ categories)"
                : "Single category"}
            </span>
          </label>

          {entry.multiGE ? (
            <div className="flex flex-wrap gap-1.5">
              {GE_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => toggleCategory(entry, list, setList, cat)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                    entry.categories.includes(cat)
                      ? "bg-[#FFCC00]/20 border-[#FFCC00]/40 text-[#FFCC00]"
                      : "bg-white/5 border-white/10 text-white/40 hover:border-white/25"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          ) : (
            <select
              value={entry.category}
              onChange={(e) =>
                updateEntry(list, setList, entry.id, { category: e.target.value })
              }
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-white/25"
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

function FormSection({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-white/[0.02] border border-white/[0.07] rounded-2xl p-5">
      <div className="flex items-baseline gap-2 mb-4">
        <h3 className="text-white font-semibold text-sm tracking-tight">{title}</h3>
        {subtitle && <span className="text-white/25 text-xs">{subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-white/30 hover:text-white/55 text-xs transition-colors mt-1"
    >
      <span className="text-base leading-none">+</span> Add entry
    </button>
  )
}

function fmt12(t: string): string {
  const [h, m] = t.split(":").map(Number)
  const ampm = h >= 12 ? "PM" : "AM"
  const h12 = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`
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
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-white/70 text-sm font-medium">{label}</span>
        <span className="text-[#990000] text-xs font-mono font-bold">
          {Math.round(value * 100)}%
        </span>
      </div>
      <p className="text-white/30 text-xs mb-2">{hint}</p>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#990000]"
      />
      <div className="flex justify-between text-white/20 text-xs mt-1">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  )
}
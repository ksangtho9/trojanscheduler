"use client"

// Info icon with an explanatory card.
// Opens on hover (mouse) and on tap/click (touch screens have no hover), closes
// on a second tap, an outside tap, or Escape. The button is 32px so it is
// tappable even though the icon itself is small.

import { useEffect, useId, useRef, useState } from "react"

interface Props {
  title: string
  children: React.ReactNode
  width?: number
}

export default function InfoTip({ title, children, width = 240 }: Props) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const cardId = useId()
  const open = pinned || hovered

  useEffect(() => {
    if (!pinned) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPinned(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [pinned])

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(true) }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setHovered(false) }}
    >
      <button
        type="button"
        aria-label={`About ${title}`}
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setPinned((v) => !v)}
        style={{
          width: 32,
          height: 32,
          margin: -10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: open ? "var(--cardinal)" : "var(--text-tertiary)",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v5M8 5.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div
        id={cardId}
        role="tooltip"
        className="transition-opacity duration-150"
        style={{
          position: "absolute",
          top: "calc(100% + 10px)",
          right: -6,
          width,
          maxWidth: "calc(100vw - 40px)",
          background: "#FFFFFF",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          padding: "14px 16px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
          zIndex: 50,
          textAlign: "left",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <div style={{ position: "absolute", top: -5, right: 10, width: 10, height: 10, background: "#FFFFFF", borderTop: "1px solid var(--border-default)", borderLeft: "1px solid var(--border-default)", transform: "rotate(45deg)" }} />
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>{title}</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)" }}>{children}</p>
      </div>
    </div>
  )
}

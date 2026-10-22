"use client"

interface Props {
  currentStep: 1 | 2 | 3
  onStartOver?: () => void
  /** Selected term, e.g. "Spring 2027". Omitted until terms have loaded. */
  termLabel?: string
}

export default function LeftPanel({ currentStep, onStartOver, termLabel }: Props) {
  const eyebrow = termLabel ? `USC · ${termLabel}` : "USC"
  const steps = [
    { num: 1, label: "Add your courses & constraints" },
    { num: 2, label: "Build 3 optimal schedules" },
    { num: 3, label: "Review & export" },
  ]
  return (
    <>
    {/* Mobile top bar */}
    <div
      className="app-sidebar-mobile"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: "100%",
        height: 64,
        background: "linear-gradient(170deg, #3d0000 0%, #6B0000 45%, #990000 100%)",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        zIndex: 20,
      }}
    >
      {/* Brand */}
      <div onClick={onStartOver} style={{ cursor: onStartOver ? "pointer" : "default" }}>
        <p style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.12em", color: "rgba(255,204,0,0.75)", textTransform: "uppercase", marginBottom: 2 }}>
          {eyebrow}
        </p>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", color: "#fff", fontSize: 18, lineHeight: 1, margin: 0 }}>
          Trojan Scheduler
        </h1>
      </div>

      {/* Right side: step indicators + start over */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {steps.map(({ num }) => {
            const active = num === currentStep
            return (
              <div
                key={num}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: active ? "2px solid rgba(255,204,0,0.75)" : "2px solid rgba(255,255,255,0.2)",
                  background: active ? "rgba(255,204,0,0.1)" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span style={{ fontSize: 9, fontWeight: 700, color: active ? "rgba(255,204,0,0.9)" : "rgba(255,255,255,0.3)" }}>
                  {num}
                </span>
              </div>
            )
          })}
        </div>
        {onStartOver && (
          <button
            onClick={onStartOver}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.45)",
              cursor: "pointer",
            }}
          >
            Start Over
          </button>
        )}
      </div>
    </div>

    {/* Desktop sidebar */}
    <div
      className="app-sidebar-desktop"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        bottom: 0,
        width: "22.222%",
        background: "linear-gradient(170deg, #3d0000 0%, #6B0000 45%, #990000 100%)",
        flexDirection: "column",
        padding: "40px 28px",
        zIndex: 10,
      }}
    >
      <div style={{ flex: 1 }}>
        <p
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.12em",
            color: "rgba(255,204,0,0.75)",
            textTransform: "uppercase",
            marginBottom: 14,
          }}
        >
          {eyebrow}
        </p>
        <h1
          onClick={onStartOver}
          style={{
            fontFamily: "'DM Serif Display', serif",
            color: "#fff",
            fontSize: 30,
            lineHeight: 1.1,
            marginBottom: 12,
            cursor: onStartOver ? "pointer" : "default",
          }}
        >
          Trojan<br />Scheduler
        </h1>
        <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, lineHeight: 1.6, maxWidth: 160 }}>
          Build the perfect USC schedule in seconds.
        </p>
      </div>
      <div>
        <p
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "rgba(255,255,255,0.3)",
            textTransform: "uppercase",
            marginBottom: 20,
          }}
        >
          How it works
        </p>
        {steps.map(({ num, label }, i) => {
          const active = num === currentStep
          return (
            <div
              key={num}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                paddingTop: i > 0 ? 16 : 0,
                marginTop: i > 0 ? 16 : 0,
                borderTop: i > 0 ? "1px solid rgba(255,255,255,0.08)" : "none",
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  flexShrink: 0,
                  border: active ? "2px solid rgba(255,204,0,0.75)" : "2px solid rgba(255,255,255,0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: active ? "rgba(255,204,0,0.1)" : "transparent",
                  marginTop: 1,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: active ? "rgba(255,204,0,0.9)" : "rgba(255,255,255,0.3)",
                  }}
                >
                  {num}
                </span>
              </div>
              <span
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  paddingTop: 4,
                  color: active ? "#fff" : "rgba(255,255,255,0.3)",
                  fontWeight: active ? 500 : 400,
                }}
              >
                {label}
              </span>
            </div>
          )
        })}

        {onStartOver && (
          <button
            onClick={onStartOver}
            style={{
              marginTop: 28,
              background: "transparent",
              border: "none",
              padding: 0,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.45)",
              cursor: "pointer",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "rgba(255,204,0,0.85)"
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "rgba(255,255,255,0.45)"
            }}
          >
            Start Over
          </button>
        )}
      </div>
    </div>
    </>
  )
}

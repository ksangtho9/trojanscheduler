"""
image_gen.py — Google Calendar-style PNG schedule renderer

Builds an HTML calendar layout and screenshots it via Playwright.
Output: 1100x700 base64-encoded PNG per schedule.

Color rules (from spec):
  - Regular course:    unique color from palette
  - GE course:         orange #FF9800
  - Double-count GE:   gold   #FFCC00
  - Online course:     slate  #546E7A
  - Linked section:    70% darkened version of parent color
"""

import asyncio
import base64
from playwright.sync_api import sync_playwright

# ── Canvas constants ──────────────────────────────────────────────────────────

W, H        = 1100, 700
HEADER_H    = 44            # day-name strip height
LEFT_W      = 54            # time-label column width
DAYS        = ["Mon", "Tue", "Wed", "Thu", "Fri"]
DAY_W       = (W - LEFT_W) / 5   # 209.2 px per day column

T_START     = 8 * 60        # 8:00 AM in minutes
T_END       = 21 * 60       # 9:00 PM in minutes
T_RANGE     = T_END - T_START
PX_MIN      = (H - HEADER_H) / T_RANGE   # pixels per minute

# ── Color palette ─────────────────────────────────────────────────────────────

_COURSE_COLORS = [
    "#4285F4",   # Blue
    "#0F9D58",   # Green
    "#AB47BC",   # Purple
    "#F4511E",   # Tomato
    "#039BE5",   # Peacock
    "#E67C73",   # Flamingo
    "#33B679",   # Sage
    "#7986CB",   # Lavender
]
GE_COLOR           = "#FF9800"
DOUBLE_COUNT_COLOR = "#FFCC00"
ONLINE_COLOR       = "#546E7A"


def _course_color(entry: dict, idx: int) -> str:
    if entry.get("is_double_count"):
        return DOUBLE_COUNT_COLOR
    if entry.get("entry_type") == "ge":
        return GE_COLOR
    if entry.get("modality") == "online":
        return ONLINE_COLOR
    return _COURSE_COLORS[idx % len(_COURSE_COLORS)]


def _darken(hex_color: str, factor: float = 0.70) -> str:
    c = hex_color.lstrip("#")
    r = int(int(c[0:2], 16) * factor)
    g = int(int(c[2:4], 16) * factor)
    b = int(int(c[4:6], 16) * factor)
    return f"#{r:02X}{g:02X}{b:02X}"


def _to_min(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


# ── Block geometry ────────────────────────────────────────────────────────────

def _block_css(day: str, start: str, end: str, color: str, inset: int = 0) -> str | None:
    """Return inline CSS for a calendar block, or None if outside visible range."""
    if day not in DAYS:
        return None
    col = DAYS.index(day)
    sm  = max(_to_min(start), T_START)
    em  = min(_to_min(end),   T_END)
    if em <= sm:
        return None

    top  = HEADER_H + (sm - T_START) * PX_MIN + 1
    ht   = (em - sm) * PX_MIN - 2
    left = LEFT_W + col * DAY_W + 3 + inset
    wd   = DAY_W - 6 - inset

    return (
        f"top:{top:.1f}px;height:{ht:.1f}px;"
        f"left:{left:.1f}px;width:{wd:.1f}px;"
        f"background:{color};"
    )


# ── HTML builder ──────────────────────────────────────────────────────────────

_CSS = f"""
* {{ margin:0; padding:0; box-sizing:border-box; }}
html, body {{
  width:{W}px; height:{H}px; overflow:hidden;
  background:#0F1117;
  font-family: Arial, Helvetica, sans-serif;
}}
.header {{
  position:absolute; left:{LEFT_W}px; top:0; right:0; height:{HEADER_H}px;
  display:flex; border-bottom:1px solid rgba(255,255,255,0.06);
}}
.dh {{
  flex:1; display:flex; align-items:center; justify-content:center;
  font-size:11px; font-weight:700; color:rgba(255,255,255,0.30);
  letter-spacing:.09em; text-transform:uppercase;
}}
.tl {{
  position:absolute; left:4px;
  font-size:9px; color:rgba(255,255,255,0.18);
  transform:translateY(-50%); white-space:nowrap;
}}
.hl {{
  position:absolute; left:{LEFT_W}px; right:0;
  height:1px; background:rgba(255,255,255,0.04);
}}
.cd {{
  position:absolute; top:{HEADER_H}px; bottom:0;
  width:1px; background:rgba(255,255,255,0.04);
}}
.blk {{
  position:absolute; border-radius:4px;
  padding:3px 6px; overflow:hidden;
}}
.bn {{
  font-size:10px; font-weight:700;
  color:rgba(0,0,0,0.82); line-height:1.3;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}}
.bp {{
  font-size:9px; color:rgba(0,0,0,0.52); line-height:1.3;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}}
"""


def _build_html(schedule: dict) -> str:
    entries = schedule.get("courses", [])

    # Day headers
    day_headers = "".join(f'<div class="dh">{d}</div>' for d in DAYS)

    # Hour grid lines + labels
    hour_els = []
    for h in range(T_START // 60, T_END // 60 + 1):
        y = HEADER_H + (h * 60 - T_START) * PX_MIN
        if y < HEADER_H or y > H:
            continue
        label = f"{h % 12 or 12}{'am' if h < 12 else 'pm'}"
        hour_els.append(
            f'<div class="hl" style="top:{y:.0f}px"></div>'
            f'<div class="tl" style="top:{y:.0f}px">{label}</div>'
        )

    # Column dividers
    col_divs = "".join(
        f'<div class="cd" style="left:{LEFT_W + i * DAY_W:.0f}px"></div>'
        for i in range(1, 5)
    )

    # Course blocks
    blocks = []
    for idx, entry in enumerate(entries):
        color  = _course_color(entry, idx)
        course = entry.get("course", "")
        prof   = entry.get("professor", "")
        prof_last = prof.split()[-1] if prof and prof != "TBA" else ""

        # Lecture blocks — one per day
        for day in entry.get("days", []):
            css = _block_css(day, entry["start_time"], entry["end_time"], color)
            if not css:
                continue
            sm = max(_to_min(entry["start_time"]), T_START)
            em = min(_to_min(entry["end_time"]), T_END)
            ht = (em - sm) * PX_MIN - 2
            if ht >= 30 and prof_last:
                inner = f'<div class="bn">{course}</div><div class="bp">{prof_last}</div>'
            else:
                inner = f'<div class="bn">{course}</div>'
            blocks.append(f'<div class="blk" style="{css}">{inner}</div>')

        # Linked section blocks (discussion/lab/quiz/etc.) — indented, darkened color
        for linked in entry.get("linked_sections", []):
            ls_color = _darken(color)
            stype = (linked.get("section_type") or "dis").capitalize()[:3]
            for day in linked.get("days", []):
                css = _block_css(
                    day, linked["start_time"], linked["end_time"],
                    ls_color, inset=10
                )
                if not css:
                    continue
                sm = max(_to_min(linked["start_time"]), T_START)
                em = min(_to_min(linked["end_time"]), T_END)
                ht = (em - sm) * PX_MIN - 2
                if ht >= 20:
                    inner = (
                        f'<div class="bn" style="font-size:9px">'
                        f'{course} {stype}</div>'
                    )
                else:
                    inner = ""
                blocks.append(f'<div class="blk" style="{css}">{inner}</div>')

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>{_CSS}</style></head>
<body>
<div class="header">{day_headers}</div>
{"".join(hour_els)}
{col_divs}
{"".join(blocks)}
</body></html>"""


# ── Public API ────────────────────────────────────────────────────────────────

def _render_sync(schedules: list[dict]) -> list[str]:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": W, "height": H})
        images = []
        for schedule in schedules[:3]:
            html = _build_html(schedule)
            page.set_content(html, wait_until="domcontentloaded")
            png = page.screenshot(type="png", clip={"x": 0, "y": 0, "width": W, "height": H})
            images.append(base64.b64encode(png).decode())
        browser.close()
    return images


async def generate_schedule_images(schedules: list[dict]) -> list[str]:
    """
    Render up to 3 schedules as base64 PNG strings.
    Runs sync Playwright in a thread to avoid Windows asyncio subprocess limitations.
    """
    return await asyncio.to_thread(_render_sync, schedules)

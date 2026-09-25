import { ImageResponse } from "next/og"

// apple-icon must be a raster format, so this renders the same mark as
// icon.svg to a PNG at build time. Satori (what ImageResponse runs on) does not
// rasterize inline SVG, so the blocks are composed as absolutely positioned
// divs — geometry is icon.svg's 64-unit grid scaled by 180/64.
export const size = { width: 180, height: 180 }
export const contentType = "image/png"

const SCALE = size.width / 64

// [x, y, width, height, fill] on the same 64-unit grid as app/icon.svg.
const BLOCKS: [number, number, number, number, string][] = [
  [10, 12, 12, 19, "#FFCC00"],
  [10, 37, 12, 15, "#FFCC00"],
  [26, 12, 12, 13, "#FFFFFF"],
  [26, 30, 12, 22, "#FFFFFF"],
  [42, 19, 12, 24, "#FFCC00"],
]

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          background: "#990000",
        }}
      >
        {BLOCKS.map(([x, y, w, h, fill], i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x * SCALE,
              top: y * SCALE,
              width: w * SCALE,
              height: h * SCALE,
              borderRadius: 3 * SCALE,
              background: fill,
            }}
          />
        ))}
      </div>
    ),
    size
  )
}

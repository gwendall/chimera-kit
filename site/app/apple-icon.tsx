import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// The vocal tract, bent the way the page draws it. Home screens round the corners themselves.
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BRAND.background,
      }}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: an icon's only content */}
      <svg width="180" height="180" viewBox="0 0 32 32">
        <defs>
          <linearGradient id="heat" x1="1" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={BRAND.heat} />
            <stop offset="1" stopColor="#ffd9b8" />
          </linearGradient>
        </defs>
        <path
          d="M22.5 26V14.5A6 6 0 0 0 16.5 8.5H6.5"
          fill="none"
          stroke="url(#heat)"
          strokeWidth="5.5"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    size,
  );
}

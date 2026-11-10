import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import curve from "@/assets/og-curve.generated.json";
import { BRAND } from "@/lib/brand";

export const alt =
  'Text to speech you can direct. The pitch of "I never said she stole my money." rises on "stole", the word the reader chose to stress.';
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const font = (name: string) => readFile(join(process.cwd(), "assets/fonts", name));

// Each word's chip is as wide as the word lasts, so the curve above it lines up with the word.
const PX_PER_SECOND = 520;
const GAP = 8;
const CURVE_HEIGHT = 136;

type Reading = { words: { text: string; t0: number; t1: number }[]; pitch: number[][] };

function layout() {
  const words = curve.stressed.words.map((w) => ({ ...w, width: Math.round((w.t1 - w.t0) * PX_PER_SECOND) }));
  const width = words.reduce((sum, w) => sum + w.width, 0) + GAP * (words.length - 1);
  // A word owns its chip and half of each gap beside it, so the curve has no break between words.
  const boxes = words.map((w, i) => {
    const left = words.slice(0, i).reduce((sum, v) => sum + v.width + GAP, 0);
    return {
      x0: i === 0 ? 0 : left - GAP / 2,
      x1: i === words.length - 1 ? width : left + w.width + GAP / 2,
    };
  });
  // Pitch in semitones, the way the ear hears it, over the range both readings share.
  const all = [...curve.plain.pitch, ...curve.stressed.pitch].map(([, hz = 0]) => hz);
  const low = Math.min(...all);
  const range = 12 * Math.log2(Math.max(...all) / low);
  const pad = 6;
  const y = (hz: number) => pad + (1 - (12 * Math.log2(hz / low)) / range) * (CURVE_HEIGHT - pad * 2);
  // Each reading maps its own word timings onto the same chips: the plain one is shorter.
  const path = ({ words: spans, pitch }: Reading) => {
    const x = (t: number) => {
      const i = Math.max(
        0,
        spans.findIndex((s) => t <= s.t1),
      );
      const span = spans[i];
      const box = boxes[i];
      if (!span || !box) return 0;
      return box.x0 + ((t - span.t0) / (span.t1 - span.t0)) * (box.x1 - box.x0);
    };
    const start = spans[0]?.t0 ?? 0;
    const end = spans[spans.length - 1]?.t1 ?? 0;
    return pitch
      .filter(([t = 0]) => t >= start && t <= end)
      .map(([t = 0, hz = low], i) => `${i ? "L" : "M"}${x(t).toFixed(1)} ${y(hz).toFixed(1)}`)
      .join(" ");
  };
  return { words, width, plain: path(curve.plain), stressed: path(curve.stressed) };
}

// Satori measures text one letter at a time but draws it kerned, so a kerned word's box ends past
// its last letter ("Text" by 16 px here). Each headline word is its own box, pulled back by its
// kerning in Geist SemiBold (units per 1,000 em, read from the font's GPOS table) and set apart by
// Geist's own space (236 units) less the headline's tracking.
const KERNING: Record<string, number> = {
  Text: -188,
  to: -14,
  speech: -50,
  you: -38,
  can: -4,
  "direct.": -59,
};

function Line({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", gap: "0.2em" }}>
      {text.split(" ").map((word) => (
        <span key={word} style={{ marginRight: `${(KERNING[word] ?? 0) / 1000}em` }}>
          {word}
        </span>
      ))}
    </div>
  );
}

export default async function Image() {
  const [medium, semibold] = await Promise.all([font("Geist-Medium.ttf"), font("Geist-SemiBold.ttf")]);
  const { words, width, plain, stressed } = layout();
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        position: "relative",
        background: BRAND.paper,
        color: BRAND.ink,
        fontFamily: "Geist",
        fontWeight: 500,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 56,
          left: 64,
          fontSize: 40,
          fontWeight: 600,
          letterSpacing: "-0.02em",
        }}
      >
        intone
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          marginTop: 118,
          fontSize: 88,
          fontWeight: 600,
          lineHeight: 1.04,
          letterSpacing: "-0.035em",
        }}
      >
        <Line text="Text to speech" />
        <Line text="you can direct." />
      </div>
      {/* No <title>: Satori draws it as text. The image's alt describes the curve. */}
      <svg
        aria-hidden="true"
        width={width}
        height={CURVE_HEIGHT}
        viewBox={`0 0 ${width} ${CURVE_HEIGHT}`}
        style={{ marginTop: 34 }}
      >
        <path
          d={plain}
          fill="none"
          stroke={BRAND.muted}
          strokeWidth={3}
          strokeDasharray="7 9"
          strokeLinecap="round"
        />
        <path
          d={stressed}
          fill="none"
          stroke={BRAND.accent}
          strokeWidth={6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div style={{ display: "flex", gap: GAP, marginTop: 12 }}>
        {words.map((w, i) => {
          const stress = w.text === curve.stress;
          const text = i === 0 ? w.text.toUpperCase() : i === words.length - 1 ? `${w.text}.` : w.text;
          return (
            <div
              key={w.t0}
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                width: w.width,
                height: 68,
                borderRadius: 18,
                border: `2px solid ${stress ? BRAND.accentFill : BRAND.line}`,
                background: stress ? BRAND.accentFill : BRAND.paper,
                color: stress ? BRAND.onAccent : BRAND.ink,
                fontSize: 40,
                letterSpacing: "-0.02em",
              }}
            >
              {text}
            </div>
          );
        })}
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Geist", data: medium, weight: 500, style: "normal" },
        { name: "Geist", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}

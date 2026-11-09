import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

export const alt = "A voice with a throat: a vocal tract lit by the sound passing through it.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const asset = (name: string) => readFile(join(process.cwd(), "assets", name));

// The picture is one real frame of the simulation saying "have" (the tube the page draws live).
export default async function Image() {
  const [regular, italic, throat] = await Promise.all([
    asset("fonts/InstrumentSerif-Regular.ttf"),
    asset("fonts/InstrumentSerif-Italic.ttf"),
    asset("throat.png"),
  ]);
  const line = { display: "flex", fontSize: 138, lineHeight: 1 } as const;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        alignItems: "center",
        background: BRAND.background,
        color: BRAND.ink,
        fontFamily: "Instrument Serif",
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: next/og draws plain img elements only */}
      <img
        alt=""
        src={`data:image/png;base64,${throat.toString("base64")}`}
        width={698}
        height={630}
        style={{ position: "absolute", top: 0, right: -30 }}
      />
      <div style={{ display: "flex", flexDirection: "column", paddingLeft: 64 }}>
        <div style={line}>A voice</div>
        <div style={line}>with a</div>
        <div style={{ ...line, color: BRAND.heat, fontStyle: "italic" }}>throat.</div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Instrument Serif", data: regular, weight: 400, style: "normal" },
        { name: "Instrument Serif", data: italic, weight: 400, style: "italic" },
      ],
    },
  );
}

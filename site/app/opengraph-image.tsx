import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

export const alt = "A voice you can direct: the spectrogram of a sentence the library just computed.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const asset = (name: string) => readFile(join(process.cwd(), "assets", name));

// The picture is a real frame of the page's monitor: the spectrogram of a sentence the voice computed.
export default async function Image() {
  const [regular, italic, picture] = await Promise.all([
    asset("fonts/InstrumentSerif-Regular.ttf"),
    asset("fonts/InstrumentSerif-Italic.ttf"),
    asset("spectrogram.png"),
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
        src={`data:image/png;base64,${picture.toString("base64")}`}
        width={698}
        height={630}
        style={{ position: "absolute", top: 0, right: 0 }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 502,
          width: 240,
          height: 630,
          background: `linear-gradient(90deg, ${BRAND.background}, ${BRAND.background}00)`,
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", paddingLeft: 64 }}>
        <div style={line}>A voice</div>
        <div style={line}>you can</div>
        <div style={{ ...line, color: BRAND.heat, fontStyle: "italic" }}>direct.</div>
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

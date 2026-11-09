"use client";

import { useEffect, useRef } from "react";
import { type Reading, studio } from "@/lib/studio";

// Everything here is drawn from the simulation's own state. The back of the throat and the palate
// stay put, as bone does; the tongue is whatever the areas leave of the space in front of them.
const WIDEN = 1.35;
const BEND = 3.2;
const HEAD_MOUTH_CM = 8.6;
const PX_PER_SECOND = 230;

interface Pt {
  x: number;
  y: number;
}

const FACE_TOP: [number, number][] = [
  [-8.1, 0.2],
  [-8.9, -0.7],
  [-9.8, -1.5],
  [-10.9, -2.6],
  [-10.1, -4.6],
  [-8.9, -6.4],
  [-8.8, -7.9],
  [-9.5, -9.8],
  [-8.8, -12.7],
  [-5.8, -15.8],
  [-1.2, -17.3],
  [4.2, -16.2],
  [8.2, -12.6],
  [9.6, -8],
  [8.8, -3.8],
  [6.6, -0.6],
  [5.4, 2.8],
  [5.8, 8],
  [6.8, 13],
];

const FACE_BOTTOM: [number, number][] = [
  [-8.3, 1.2],
  [-8.5, 2.4],
  [-8, 3.6],
  [-8.7, 5.2],
  [-7.2, 6.8],
  [-4.2, 7],
  [-2.9, 8.2],
  [-3.1, 10.5],
  [-4, 13],
];

/** A smooth line through points (Catmull-Rom as Béziers). */
function trace(ctx: CanvasRenderingContext2D, points: Pt[], join = false) {
  const first = points[0];
  if (!first) return;
  if (join) ctx.lineTo(first.x, first.y);
  else ctx.moveTo(first.x, first.y);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i] ?? first;
    const p1 = points[i] ?? first;
    const p2 = points[i + 1] ?? p1;
    const p3 = points[i + 2] ?? p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    );
  }
}

/** The fixed wall (back of the throat, then the palate) at a distance along it, and the way in. */
function along(s: number, pharynx: number, _mouth: number): { wall: Pt; normal: Pt; inBend: boolean } {
  const quarter = (Math.PI * BEND) / 4;
  const straight = pharynx - quarter;
  if (s < straight) {
    return { wall: { x: 0, y: BEND + straight - s }, normal: { x: -1, y: 0 }, inBend: false };
  }
  if (s < pharynx + quarter) {
    const angle = (s - straight) / BEND;
    return {
      wall: { x: -BEND + BEND * Math.cos(angle), y: BEND - BEND * Math.sin(angle) },
      normal: { x: -Math.cos(angle), y: Math.sin(angle) },
      inBend: true,
    };
  }
  return { wall: { x: -BEND - (s - pharynx - quarter), y: 0 }, normal: { x: 0, y: 1 }, inBend: false };
}

/** Canvas can't read CSS variables, so the page's font families are looked up once. */
const fonts = { mono: "monospace", serif: "serif" };

/** How much the air in a section is moving, from cold flesh to white heat. */
function colorFor(level: number): string {
  const stops: [number, number, number, number][] = [
    [0, 24, 17, 13],
    [0.42, 176, 44, 22],
    [0.78, 255, 104, 58],
    [1, 255, 222, 186],
  ];
  // The top of the scale is kept for the loudest instants, so a held vowel doesn't turn to a white block.
  const v = Math.max(0, Math.min(1, level ** 0.8 * 0.94));
  for (let i = 1; i < stops.length; i++) {
    const high = stops[i] as [number, number, number, number];
    const low = stops[i - 1] as [number, number, number, number];
    if (v <= high[0]) {
      const u = (v - low[0]) / (high[0] - low[0]);
      return `rgb(${Math.round(low[1] + (high[1] - low[1]) * u)},${Math.round(low[2] + (high[2] - low[2]) * u)},${Math.round(low[3] + (high[3] - low[3]) * u)})`;
    }
  }
  return "rgb(255,222,186)";
}

function curveValue(curve: [number, number][], t: number): number {
  const first = curve[0];
  if (!first) return 0;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i];
    const a = curve[i - 1];
    if (!a || !b) continue;
    if (t <= b[0]) return a[1] + ((b[1] - a[1]) * (t - a[0])) / Math.max(b[0] - a[0], 1e-6);
  }
  return curve[curve.length - 1]?.[1] ?? 0;
}

function drawScore(
  ctx: CanvasRenderingContext2D,
  reading: Reading,
  x: number,
  y: number,
  width: number,
  height: number,
  ink: number,
) {
  const { score, t } = reading;
  if (!score) return;
  const center = x + width * 0.28;
  const pxPerSecond = PX_PER_SECOND;
  const at = (time: number) => center + (time - t) * pxPerSecond;
  const left = t - (center - x) / pxPerSecond;
  const right = t + (x + width - center) / pxPerSecond;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 30, width, height + 42);
  ctx.clip();

  // Scaled to this sentence, so its intonation is visible whatever the voice's range.
  let lowest = Number.POSITIVE_INFINITY;
  let highest = 0;
  for (const [, hz] of score.pitch) {
    if (hz < lowest) lowest = hz;
    if (hz > highest) highest = hz;
  }
  const middle = Math.sqrt(lowest * highest);
  const span = Math.max(highest / lowest, 2 ** (10 / 12)) ** 0.62;
  const low = Math.log(middle / span);
  const high = Math.log(middle * span);
  const pitchY = (hz: number) => {
    return y + 16 + (1 - (Math.log(Math.max(hz, 40)) - low) / (high - low)) * (height - 54);
  };
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = `rgba(255,92,54,${0.9 * ink})`;
  ctx.beginPath();
  let pen = false;
  for (let time = Math.max(left, 0); time < Math.min(right, score.duration); time += 0.012) {
    const px = at(time);
    const py = pitchY(curveValue(score.pitch, time));
    if (pen) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    pen = true;
  }
  ctx.stroke();

  ctx.textBaseline = "alphabetic";
  ctx.font = `500 12px ${fonts.mono}`;
  ctx.textAlign = "center";
  for (const sound of score.sounds) {
    if (sound.t1 < left || sound.t0 > right || sound.sound === "_") continue;
    const now = t >= sound.t0 && t < sound.t1;
    ctx.fillStyle = now ? `rgba(255,120,84,${ink})` : `rgba(244,239,232,${0.42 * ink})`;
    ctx.fillText(sound.sound, at((sound.t0 + sound.t1) / 2), y + height - 6);
  }

  ctx.font = `italic ${width < 480 ? 17 : 22}px ${fonts.serif}`;
  ctx.textAlign = "left";
  for (const word of score.words ?? []) {
    if (word.t1 < left || word.t0 > right) continue;
    const now = t >= word.t0 && t < word.t1;
    ctx.fillStyle = now ? `rgba(244,239,232,${ink})` : `rgba(244,239,232,${0.36 * ink})`;
    ctx.fillText(word.text, at(word.t0), y + 4);
  }

  ctx.strokeStyle = `rgba(244,239,232,${0.24 * ink})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center, y - 22);
  ctx.lineTo(center, y + height + 4);
  ctx.stroke();
  ctx.restore();
}

/**
 * The air's movement per section, measured over every state since the last drawn frame and fading
 * slowly. Pressure itself flips sign at the pitch of the voice: painted directly it would flash the
 * whole tube dozens of times a second.
 */
interface Heat {
  levels: Float32Array;
  peak: number;
  loudest: number;
}

function absorb(heat: Heat, recent: Float32Array[]) {
  const first = recent[0];
  if (!first) return;
  const sections = (first[3] ?? 0) + (first[4] ?? 0) + (first[5] ?? 0);
  if (heat.levels.length !== sections) heat.levels = new Float32Array(sections);
  const at = 6 + sections;
  const airway = (first[3] ?? 0) + (first[4] ?? 0);
  const raw = new Float32Array(sections);
  for (const state of recent) {
    for (let i = 0; i < sections; i++) {
      // The pressure difference across a cell is what pushes the air through it. Pressure alone is nearly
      // uniform along a tube, which paints one flat color. The lips and the end of the nose open on still air.
      const open = i === airway - 1 || i === sections - 1;
      const value = Math.abs((state[at + i] ?? 0) - (open ? 0 : (state[at + i + 1] ?? 0)));
      if (value > (raw[i] ?? 0)) raw[i] = value;
    }
  }
  const moved = new Float32Array(sections);
  let top = 0;
  for (let i = 0; i < sections; i++) {
    const value = ((raw[i - 1] ?? raw[i] ?? 0) + 2 * (raw[i] ?? 0) + (raw[i + 1] ?? raw[i] ?? 0)) / 4;
    moved[i] = value;
    if (value > top) top = value;
  }
  heat.loudest = Math.max(heat.loudest, top);
  heat.peak = Math.max(top, heat.peak * 0.99, heat.loudest * 0.1, 1e-3);
  for (let i = 0; i < sections; i++) {
    heat.levels[i] = Math.max((moved[i] ?? 0) / heat.peak, (heat.levels[i] ?? 0) * 0.88);
  }
}

interface Label {
  text: string;
  from: Pt;
  to: Pt;
}

function drawHead(ctx: CanvasRenderingContext2D, frame: Float32Array, heat: Heat, ink: number): Label[] {
  const velum = frame[0] ?? 0;
  const pharynx = frame[1] ?? 8;
  const mouth = frame[2] ?? 8;
  const nPh = frame[3] ?? 0;
  const nOr = frame[4] ?? 0;
  const nNa = frame[5] ?? 0;
  const count = nPh + nOr;
  const areaAt = 6;
  const length = pharynx + mouth;

  const walls: Pt[] = [];
  const inner: Pt[] = [];
  const quarter = (Math.PI * BEND) / 4;
  for (let i = 0; i < count; i++) {
    const s = (i / (count - 1)) * length;
    // Smoothed along the tube, without reading past either end of it.
    const before = frame[areaAt + Math.max(i - 1, 0)] ?? 0;
    const after = frame[areaAt + Math.min(i + 1, count - 1)] ?? 0;
    const area = before + 2 * (frame[areaAt + i] ?? 0) + after;
    let depth = 2 * Math.sqrt(Math.max(area / 4, 0) / Math.PI) * WIDEN;
    const { wall, normal, inBend } = along(s, pharynx, mouth);
    if (inBend || Math.abs(s - pharynx) < quarter * 1.4) depth = Math.min(depth, BEND * 0.92);
    walls.push(wall);
    inner.push({ x: wall.x + normal.x * depth, y: wall.y + normal.y * depth });
  }
  const lastWall = walls[walls.length - 1] ?? { x: -mouth, y: 0 };
  const lastInner = inner[inner.length - 1] ?? lastWall;
  const lipGap = Math.abs(lastInner.y - lastWall.y);
  const size = mouth / HEAD_MOUTH_CM;
  const chinDrop = Math.max(0, lipGap - 0.5) * 0.7;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // The head, a static drawing except for the jaw, which follows the real lip opening.
  ctx.strokeStyle = `rgba(244,239,232,${0.3 * ink})`;
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  trace(
    ctx,
    FACE_TOP.map(([x, y]) => ({ x: x * size, y: y * size })),
  );
  ctx.stroke();
  ctx.beginPath();
  trace(
    ctx,
    FACE_BOTTOM.map(([x, y]) => ({ x: x * size, y: y * size + (y < 8.5 ? chinDrop : chinDrop * 0.3) })),
  );
  ctx.stroke();

  // The tongue: the flesh the areas leave in front of the air.
  ctx.beginPath();
  const tongue = inner.slice(Math.round(nPh * 0.45));
  trace(ctx, tongue);
  ctx.lineTo(lastInner.x + 0.4, lastInner.y + 1.3 + chinDrop * 0.5);
  ctx.lineTo(-4.2 * size, 5.4 * size + chinDrop * 0.6);
  ctx.lineTo(-1.2, (inner[Math.round(nPh * 0.45)]?.y ?? 5) + 0.6);
  ctx.closePath();
  ctx.fillStyle = `rgba(255,92,54,${0.11 * ink})`;
  ctx.fill();

  // The trachea, below the folds.
  const glottis = walls[0] ?? { x: 0, y: pharynx };
  const glottisInner = inner[0] ?? glottis;
  ctx.strokeStyle = `rgba(244,239,232,${0.2 * ink})`;
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(glottis.x, glottis.y);
  ctx.lineTo(glottis.x, glottis.y + 5.5);
  ctx.moveTo(glottis.x - 1.7, glottis.y);
  ctx.lineTo(glottis.x - 1.7, glottis.y + 5.5);
  ctx.stroke();

  // The nose opens only when the velum does.
  const open = Math.max(0, Math.min(1, velum / 0.7));
  const noseStart: Pt = { x: -BEND - 0.4, y: -0.25 };
  const noseEnd: Pt = { x: -8.8 * size, y: -3.1 * size };
  const noseControl: Pt = { x: -5.6 * size, y: -5.6 * size };
  for (let i = 0; i < nNa - 1; i++) {
    const a = i / (nNa - 1);
    const b = (i + 1) / (nNa - 1);
    const point = (u: number): Pt => ({
      x: (1 - u) ** 2 * noseStart.x + 2 * (1 - u) * u * noseControl.x + u ** 2 * noseEnd.x,
      y: (1 - u) ** 2 * noseStart.y + 2 * (1 - u) * u * noseControl.y + u ** 2 * noseEnd.y,
    });
    const p = point(a);
    const q = point(b);
    const area = frame[areaAt + count + i] ?? 0;
    ctx.lineWidth = Math.max(0.12, 2 * Math.sqrt(Math.max(area, 0) / Math.PI) * 0.8);
    ctx.strokeStyle = open > 0.02 ? colorFor((heat.levels[count + i] ?? 0) * open) : "rgb(40,34,30)";
    ctx.globalAlpha = (0.26 + 0.74 * open) * ink;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The air: one cell per section of the simulation, colored by its pressure right now.
  for (let i = 0; i < count - 1; i++) {
    const a = walls[i];
    const b = walls[i + 1];
    const c = inner[i + 1];
    const d = inner[i];
    if (!a || !b || !c || !d) continue;
    ctx.globalAlpha = ink;
    const color = colorFor(heat.levels[i] ?? 0);
    ctx.fillStyle = color;
    ctx.strokeStyle = color; // the same color, to close the hairline seams between cells
    ctx.lineWidth = 0.04;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = `rgba(244,239,232,${0.92 * ink})`;
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  trace(ctx, walls);
  ctx.stroke();
  ctx.beginPath();
  trace(ctx, inner);
  ctx.stroke();

  // The velum: a flap that lifts to seal the nose.
  const hinge: Pt = { x: -BEND - 0.9, y: 0 };
  const angle = 0.5 + open * 0.95;
  ctx.lineWidth = 0.2;
  ctx.strokeStyle = `rgba(244,239,232,${0.8 * ink})`;
  ctx.beginPath();
  ctx.moveTo(hinge.x, hinge.y);
  ctx.quadraticCurveTo(
    hinge.x + 0.8,
    hinge.y + 0.25,
    hinge.x + Math.cos(angle) * 2.1,
    hinge.y + Math.sin(angle) * 2.1,
  );
  ctx.stroke();

  const pivot = inner[Math.round(nPh + nOr * 0.42)] ?? lastInner;
  return [
    { text: "tongue", from: pivot, to: { x: -12.6 * size, y: 11.4 * size } },
    { text: "lips", from: lastInner, to: { x: lastInner.x - 1.6, y: lastInner.y + 3.4 } },
    { text: "velum", from: hinge, to: { x: hinge.x + 6.2, y: -3.8 } },
    { text: "vocal folds", from: glottisInner, to: { x: glottisInner.x + 6.4, y: glottisInner.y + 0.8 } },
  ];
}

/** Labels are drawn in screen pixels: text set at a fraction of a pixel and scaled up renders badly. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  labels: Label[],
  x: number,
  y: number,
  scale: number,
  ink: number,
) {
  ctx.font = `12px ${fonts.mono}`;
  ctx.textBaseline = "middle";
  for (const { text, from, to } of labels) {
    const start = { x: x + from.x * scale, y: y + from.y * scale };
    const end = { x: x + to.x * scale, y: y + to.y * scale };
    ctx.strokeStyle = `rgba(244,239,232,${0.3 * ink})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.fillStyle = `rgba(244,239,232,${0.66 * ink})`;
    ctx.textAlign = end.x > start.x ? "left" : "right";
    ctx.fillText(text, end.x + (end.x > start.x ? 7 : -7), end.y);
  }
}

const SCALE_LOW = 40;
const SCALE_HIGH = 20_000;

/** A scrolling spectrogram of whatever is playing: the creatures' throats aren't drawn, only heard. */
class Scope {
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d", { willReadFrequently: false });
  private bins = new Uint8Array(2048);
  private palette: [number, number, number][] = [];

  constructor() {
    for (let i = 0; i < 256; i++) {
      const match = colorFor((i / 255) ** 0.7).match(/\d+/g) ?? ["0", "0", "0"];
      // Silence has to be the page's own black, or the picture shows as a tinted rectangle.
      const a = Math.min(1, i / 48);
      this.palette.push([
        12 + (Number(match[0]) - 12) * a,
        10 + (Number(match[1]) - 10) * a,
        9 + (Number(match[2]) - 9) * a,
      ]);
    }
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number, title: string) {
    const analyser = studio.analyser;
    const off = this.context;
    if (!analyser || !off) return;
    const w = Math.max(Math.round(width), 1);
    const h = Math.max(Math.round(height), 1);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.bins.length !== analyser.frequencyBinCount)
      this.bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(this.bins);

    const step = Math.max(3, Math.round(w / 130));
    off.globalCompositeOperation = "copy";
    off.drawImage(this.canvas, -step, 0);
    off.globalCompositeOperation = "source-over";
    const column = off.createImageData(step, h);
    const nyquist = analyser.context.sampleRate / 2;
    for (let y = 0; y < h; y++) {
      const hz = SCALE_LOW * (SCALE_HIGH / SCALE_LOW) ** (1 - y / h);
      const value = this.bins[Math.round((hz / nyquist) * this.bins.length)] ?? 0;
      const color = this.palette[value] ?? [0, 0, 0];
      for (let x = 0; x < step; x++) {
        const at = (y * step + x) * 4;
        column.data[at] = color[0];
        column.data[at + 1] = color[1];
        column.data[at + 2] = color[2];
        column.data[at + 3] = 255;
      }
    }
    off.putImageData(column, w - step, 0);

    ctx.drawImage(this.canvas, 0, 0, width, height);
    ctx.font = `italic 34px ${fonts.serif}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgb(244,239,232)";
    ctx.fillText(title, 24, 52);
  }
}

export function Throat() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let frameId = 0;
    const heat: Heat = { levels: new Float32Array(0), peak: 1e-3, loudest: 0 };
    const style = getComputedStyle(document.documentElement);
    fonts.mono = style.getPropertyValue("--font-mono").trim() || "monospace";
    fonts.serif = style.getPropertyValue("--font-serif").trim() || "serif";
    const scope = new Scope();

    const draw = () => {
      frameId = requestAnimationFrame(draw);
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(box.width * dpr);
      const height = Math.round(box.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);

      const reading = studio.read();
      const compact = box.width < 520 || box.height < 480;
      const stripHeight = compact ? 92 : Math.min(150, box.height * 0.22);
      const headHeight = box.height - stripHeight - 24;
      const ink = reading.mode === "ghost" ? 0.78 : 1;

      if (reading.mode === "scope") {
        scope.draw(ctx, box.width, box.height, studio.getSnapshot().label);
        return;
      }
      absorb(heat, reading.recent);
      if (reading.frame) {
        // On a phone there is only room for the airway itself, so the view closes in on it.
        const scale = compact
          ? Math.min(headHeight / 16.5, box.width / 15)
          : Math.min(headHeight / 33, box.width / 25);
        const x = compact ? box.width / 2 + 4.6 * scale : box.width * 0.56;
        const y = compact ? headHeight / 2 - 1.6 * scale : headHeight * 0.55;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        const labels = drawHead(ctx, reading.frame, heat, ink);
        ctx.restore();
        if (!compact) drawLabels(ctx, labels, x, y, scale, ink);
      }
      drawScore(ctx, reading, 24, box.height - stripHeight, box.width - 48, stripHeight - 24, ink);
    };
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="throat-canvas"
      role="img"
      aria-label="A live simulation of a vocal tract, lit where the air is pushed hardest"
    />
  );
}

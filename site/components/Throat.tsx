"use client";

import { useEffect, useRef } from "react";
import { type AnatomySnapshot, anatomySnapshot } from "@/lib/chimera-visual/trace";
import { AnatomyRenderer } from "@/lib/chimera-visual/vendor/anatomy";
import { V } from "@/lib/chimera-visual/vendor/colors";
import { Glow, setDisplayFont } from "@/lib/chimera-visual/vendor/vector";
import { studio } from "@/lib/studio";

/** Chimera's own profile display, fed by the frame sounding on the shared playback clock. */
export function Throat() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const renderer = new AnatomyRenderer();
    const glow = new Glow();
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    if (font) setDisplayFont(font);
    let width = 0;
    let height = 0;
    let dpr = 1;
    let bodyScale = 1;
    let pharynx = 1;
    const fit = () => {
      const box = canvas.getBoundingClientRect();
      width = box.width;
      height = box.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      renderer.resize(width, height, bodyScale, pharynx);
    };
    const resize = new ResizeObserver(fit);
    resize.observe(canvas);
    fit();
    studio.wantGhost();
    let raf = 0;
    let last = performance.now();
    let lastState: Float32Array | null = null;
    let snapshot: AnatomySnapshot | null = null;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const reading = studio.read();
      if (reading.frame !== lastState) {
        lastState = reading.frame;
        snapshot = anatomySnapshot(reading.frame);
        if (
          snapshot &&
          (snapshot.model.tract.scale !== bodyScale || snapshot.model.bodyParams.pharynx !== pharynx)
        ) {
          bodyScale = snapshot.model.tract.scale;
          pharynx = snapshot.model.bodyParams.pharynx;
          renderer.resize(width, height, bodyScale, pharynx);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (snapshot && width > 0 && height > 0) {
        const { model, artic: a, frame } = snapshot;
        renderer.face.update(null, dt);
        renderer.draw(
          ctx,
          model,
          frame,
          a,
          null,
          { pressure: false, particles: false, grid: true, calipers: false },
          {
            hover: null,
            drag: null,
            dt,
            formants: [],
            slots: [
              { label: "Tongue", value: a.tbY.toFixed(1), unit: "cm", color: V.green },
              { label: "Jaw", value: a.jaw.toFixed(1), unit: "cm", color: V.red },
              { label: "Lips", value: a.lipAp.toFixed(1), unit: "cm", color: V.pink },
              { label: "Velum", value: frame.velumPort.toFixed(1), unit: "cm²", color: V.white },
            ],
            info: [
              reading.mode === "live" ? "LIVE VOICE" : "SILENT PREVIEW",
              `${reading.t.toFixed(2)} SECONDS`,
            ],
          },
        );
        glow.apply(canvas, ctx, dpr);
      } else {
        ctx.fillStyle = "#a8a6a2";
        ctx.font = "12px monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          reading.mode === "scope"
            ? "Human anatomy resumes with the next voice."
            : "Loading the voice model...",
          width / 2,
          height / 2,
        );
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
    };
  }, []);
  return (
    <canvas
      ref={canvasRef}
      className="throat-canvas"
      role="img"
      aria-label="Chimera's full head profile. Tongue, jaw, lips and soft palate follow the actual voice being played."
    />
  );
}

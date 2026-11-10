import { describe, expect, test } from "bun:test";
import { anatomySnapshot } from "../site/lib/chimera-visual/trace";
import { AnatomyRenderer } from "../site/lib/chimera-visual/vendor/anatomy";
import { buildProfile } from "../site/lib/chimera-visual/vendor/profile";
import { createVoice } from "./index.ts";

const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);
const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);

describe("the canonical Chimera profile", () => {
  test("decodes real playback frames and fits the full crown on phones and desktop", async () => {
    const voice = await createVoice({ wasm, dictionary });
    for (const body of ["male", "female", "child", { size: 1.3, throat: 1.3 }] as const) {
      let count = 0;
      let last: Float32Array | null = null;
      let minLip = Infinity;
      let maxLip = -Infinity;
      const chunks = voice.stream("mama", {
        body,
        chunkSize: 4096,
        airway(state) {
          last = state;
          const snapshot = anatomySnapshot(state);
          expect(snapshot).not.toBeNull();
          if (!snapshot) return;
          count++;
          minLip = Math.min(minLip, snapshot.frame.lipArea);
          maxLip = Math.max(maxLip, snapshot.frame.lipArea);
          const profile = buildProfile(snapshot.model, snapshot.frame, snapshot.artic);
          for (const [width, height] of [
            [320, 440],
            [375, 440],
            [640, 440],
            [1024, 560],
          ]) {
            const renderer = new AnatomyRenderer();
            renderer.resize(
              width ?? 0,
              height ?? 0,
              snapshot.model.tract.scale,
              snapshot.model.bodyParams.pharynx,
            );
            for (const point of [...profile.skinUpper, ...profile.skinLower]) {
              expect(renderer.X(point)).toBeGreaterThanOrEqual(0);
              expect(renderer.X(point)).toBeLessThanOrEqual(width ?? 0);
              expect(renderer.Y(point)).toBeGreaterThanOrEqual(0);
              expect(renderer.Y(point)).toBeLessThanOrEqual(height ?? 0);
            }
          }
        },
      });
      for (const _chunk of chunks) {
        /* Rendering drives the actual engine trace. */
      }
      expect(count).toBeGreaterThan(5);
      expect(maxLip - minLip).toBeGreaterThan(0.5);
      const valid = last as Float32Array | null;
      expect(valid).not.toBeNull();
      if (!valid) continue;
      const prefix = 6 + 2 * ((valid[3] ?? 0) + (valid[4] ?? 0) + (valid[5] ?? 0));
      expect(anatomySnapshot(valid.subarray(0, prefix))).toBeNull();
      expect(anatomySnapshot(valid.subarray(0, valid.length - 1))).toBeNull();
      const wrongVersion = valid.slice();
      wrongVersion[prefix] = 2;
      expect(anatomySnapshot(wrongVersion)).toBeNull();
      const badCount = valid.slice();
      badCount[prefix + 23] = 100_000;
      expect(anatomySnapshot(badCount)).toBeNull();
    }
  });
});

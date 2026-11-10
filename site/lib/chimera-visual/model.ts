import type { HumanBody, Vec } from "./types";

/** Only the coordinate transform needed by Chimera's display, not a second voice engine. */
export class VoiceModel {
  readonly tract;
  constructor(
    readonly bodyParams: HumanBody,
    readonly nPh: number,
    readonly nOr: number,
  ) {
    const { scale, pharynx } = bodyParams;
    this.tract = {
      scale,
      P(x: number, y: number): Vec {
        return {
          x: (x > 0.5 ? 0.5 + (x - 0.5) * 0.86 : x) * scale,
          y: (y < 7 ? 7 - (7 - y) * pharynx : y) * scale,
        };
      },
      unP(x: number, y: number): Vec {
        const xx = x / scale;
        const yy = y / scale;
        return {
          x: xx > 0.5 ? 0.5 + (xx - 0.5) / 0.86 : xx,
          y: yy < 7 ? 7 - (7 - yy) / pharynx : yy,
        };
      },
    };
  }
}

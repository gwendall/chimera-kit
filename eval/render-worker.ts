/// <reference lib="webworker" />
/** Renders jobs through the built package, so the evaluation tests exactly what would ship. */
import { type Body, createVoice } from "../dist/index.js";
import { encodeWav } from "./wav.ts";

export interface RenderJob {
  text: string;
  body: Body;
  path: string;
}

const voice = await createVoice();

self.onmessage = async (event: MessageEvent<RenderJob>) => {
  const { text, body, path } = event.data;
  const { audio, sampleRate } = voice.render(text, { body });
  await Bun.write(path, encodeWav(audio, sampleRate));
  self.postMessage(path);
};

self.postMessage("ready");

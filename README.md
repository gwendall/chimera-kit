# intone

Text to speech in the browser, with no model weights and no server. It speaks by simulating a
human airway: vocal folds, a moving tongue and lips, air through a tube.

It doesn't sound natural, and it isn't trying to. It sounds uncanny, it fits in a few hundred
kilobytes, and because every sound comes from an articulation, the delivery can be controlled
by a program.

> **Status: private, pre-release.** Not on npm yet, and the API will change.

## Usage

```ts
import { createVoice, play } from "intone";

const voice = await createVoice({ body: "female" });
await play(voice.stream("The birch canoe slid on the smooth planks."), voice.sampleRate).done;
```

`play` starts with the first 128 samples and keeps a quarter of a second computed ahead of the
speakers; `stop()` or an `AbortSignal` cuts it short. Browsers keep audio suspended until the
page gets a click or a key press, so call it from one. The samples are computed on the calling
thread, about a third of one core while it speaks. To leave that thread free, run the voice in a
Worker: the same samples, the same calls, but `render` and `stream` are asynchronous.

```ts
import { createWorkerVoice } from "intone";

const voice = await createWorkerVoice({ body: "female" });
await voice.say("Hello there.").done;
const speech = voice.say(answer); // tokens as they arrive, spoken clause by clause
speech.stop(); // when the user interrupts
```

`say` sends the samples from the worker to the audio thread directly, so a busy page cannot make
the voice stutter. `stream` and `render` are there too, asynchronous.

The worker script is `intone/worker.js`, found next to the module with
`new URL("./worker.js", import.meta.url)`; pass `worker` to start it some other way.

Text that is still being written, such as a language model's answer, is spoken clause by clause
as it arrives. `clauses` reads it as Markdown (code blocks are skipped, links read as their text)
and cuts it at punctuation and line ends:

```ts
import { clauses } from "intone";

async function* speech(tokens: AsyncIterable<string>) {
  for await (const clause of clauses(tokens)) yield* voice.stream(clause);
}
await play(speech(answer), voice.sampleRate).done;
```

The first clause leaves at its first punctuation, and a run of more than eight words without any
is cut before a conjunction. With tokens arriving at 40 a second, the first sound came 0.13 s
after the answer started (three tokens, then the engine's start), and each clause is computed
while the one before it plays.

For a file, or to mix the voice yourself, `render` returns every sample at once:

```ts
const { audio, sampleRate } = voice.render("Hello there.", { rate: 1.1, accent: 0.3 });
```

Planning takes a fraction of a millisecond whatever the length of the text, and speech starts at
the first sample.

| Option   | Meaning                                                                   |
| -------- | ------------------------------------------------------------------------- |
| `body`   | `"male"`, `"female"`, `"child"`, or a blend `{ female: 0.5, child: 0.2 }` |
| `rate`   | speaking-rate multiplier                                                  |
| `f0`     | baseline pitch in Hz                                                      |
| `accent` | pitch excursion on stressed syllables                                     |

`createVoice({ dictionary: false })` skips the pronouncing dictionary and uses spelling rules
alone: 189 KB in all, at a cost in pronunciation.

## The device's voices

The same calls can speak through the voices the device already has (Web Speech): nothing to
download, natural-sounding, but the system decides almost everything. It takes one rate, pitch
and volume per clause, and `lost` says what of a delivery it could not apply.

```ts
import { createSystemVoice } from "intone/web-speech";

const voice = await createSystemVoice({ lang: "en" });
const speech = voice.say(answer, { delivery: "calm" }); // a string, or tokens as they arrive
speech.lost; // ["pitch range", "breath", "tension", "pause length"]
await speech.done;
```

## Cost

|                                              | gzipped |
| -------------------------------------------- | ------- |
| Engine (`intone_chimera.wasm`)               | 188 KB  |
| JavaScript: `createVoice` alone              | 1.4 KB  |
| JavaScript: a chat (`clauses`, `play`)       | 4.1 KB  |
| JavaScript: everything                       | 7.8 KB  |
| JavaScript: a voice in a Worker (both sides) | 6.3 KB  |
| JavaScript: the device's voices only         | 2.8 KB  |
| Pronouncing dictionary (CMUdict, English)    | 869 KB  |

On an Apple M2, loading takes about 70 ms once per page, the first audible sample comes about
10 ms after asking, and one voice takes about a third of one core in real time. Phones have not
been measured yet. The rendering is deterministic: the same text and options always give the
same samples.

## Intelligibility

Word errors made by two speech recognizers on sentences not used for tuning, over two voices. The
control is macOS `say`, which shows what a clear voice scores on the same test.

|                                 | Parakeet TDT 0.6b v3 | Whisper large-v3-turbo |
| ------------------------------- | -------------------- | ---------------------- |
| intone                          | 46.9 %               | 26.5 %                 |
| Control (macOS `say`, Samantha) | 2.3 %                | 2.6 %                  |

It is still hard to understand, and improving that is the current work. See
[eval/README.md](eval/README.md) for the method.

## How it stays in step with upstream

The engine is [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth) by Jameson Hodge, a
physical-modeling vocal synthesizer, kept unmodified in `crates/chimera` as a git subtree.
`bun run sync-upstream` merges new upstream work in. Everything specific to this package lives in
`crates/intone-chimera` and `src/`.

## Where it is going

One API for speech, singing and sounds that are not words, over any engine, local first. See
[docs/design.md](docs/design.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The evaluation harness and its rules are in
[eval/README.md](eval/README.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

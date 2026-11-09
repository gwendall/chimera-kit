# intone

Text to speech in the browser, with no model weights and no server. It speaks by simulating a
human airway: vocal folds, a moving tongue and lips, air through a tube.

It doesn't sound natural, and it isn't trying to. It sounds uncanny, it fits in a few hundred
kilobytes, and because every sound comes from an articulation, the delivery can be controlled
by a program.

> **Status: private, pre-release.** Not on npm yet, and the API will change.

## Usage

```ts
import { createVoice } from "intone";

const voice = await createVoice({ body: "female" });
const { audio, sampleRate } = voice.render("The birch canoe slid on the smooth planks.", {
  rate: 1.1,
  accent: 0.3,
});

const context = new AudioContext({ sampleRate });
const buffer = context.createBuffer(1, audio.length, sampleRate);
buffer.copyToChannel(audio, 0);
const source = context.createBufferSource();
source.buffer = buffer;
source.connect(context.destination);
source.start();
```

Render in a Worker: `render` blocks until the utterance is done.

For chats and anything that must answer at once, `voice.stream(text)` gives the same samples as
they are computed, 128 at a time unless `chunkSize` says otherwise (up to 4096):

```ts
for (const chunk of voice.stream("Hello there.")) player.push(chunk);
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

## Cost

|                                           | gzipped |
| ----------------------------------------- | ------- |
| Engine (`intone_chimera.wasm`)            | 188 KB  |
| JavaScript                                | 1.3 KB  |
| Pronouncing dictionary (CMUdict, English) | 869 KB  |

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

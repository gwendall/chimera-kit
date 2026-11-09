# intone

Speech that runs in the page, starts in milliseconds and does what your code says, down to the
syllable. No model weights, no server.

intone is how you use [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth), the physical
voice model by [Jameson Hodge](https://github.com/jamesondh), in a real product: streaming, clause
cutting for language models, direction, workers, and one interface that also drives other engines
([`intone/speaker`](#one-interface-three-backends)).

CHIMERA doesn't sound natural, and it isn't trying to. It sounds uncanny, it fits in a few hundred
kilobytes, and because every sound comes from an articulation, the delivery can be controlled by a
program. When you want a natural voice instead, change one line and keep the rest of your code.

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
as it arrives. `speech` reads it as Markdown (code blocks are skipped, links read as their text)
and cuts it at punctuation and line ends:

```ts
import { play, speech } from "intone";

await play(speech(voice, answer), voice.sampleRate).done;
```

The first clause leaves at its first punctuation, and a run of more than eight words without any
is cut before a conjunction. With tokens arriving at 40 a second, the first sound came 0.13 s
after the answer started (three tokens, then the engine's start), and each clause is computed
while the one before it plays. Each clause ends on the pause the whole text would have had there:
0.14 s after a comma, 0.3 s after a sentence. `clauses`, `withPause` and `pauseAfter` are the parts,
for a pipeline of your own.

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
| `style`  | a score transform for everything planned from text: `deliver("calm")`     |

`createVoice({ dictionary: false })` skips the pronouncing dictionary and uses spelling rules
alone: 223 KB in all, at a cost in pronunciation.

### Watching the throat

Because the voice is a simulated airway, the airway can be read while it speaks: the area and the
pressure of every section of tube, from the vocal folds to the lips and through the nose. Use it
to draw the throat, or to drive a character's mouth from the real lip opening.

```ts
const chunks = voice.stream("Hello there.", {
  airway(state) {
    const [velum, pharynxLength, mouthLength, pharynx, mouth, nose] = state;
    const areas = state.subarray(6, 6 + pharynx + mouth + nose); // then the pressures
  },
});
```

### Shaping one reading

`plan` gives the score the voice would speak: every sound with its timing, the pitch, and where
each word lies. Change it, then render the score itself, timing and pitch kept to the sample:

```ts
import { take } from "intone";

const t = take(voice.plan("I never said she stole my money."));
t.word("never").emphasize();
t.word("money").pitch("+2st").stretch(1.3);
const { audio } = voice.render(t.score);
```

A score already holds its timing and pitch, so `rate`, `f0` and `accent` are refused with one:
`stretch`, `shift` and `deliver` change them instead.

The same transforms can shape every reading. A `style` is applied to each score the voice plans
from text, whether it is given to `createVoice` or to one call:

```ts
import { deliver, speech } from "intone";

const calm = await createVoice({ body: "female", style: deliver("calm") });
await play(calm.stream("Take a breath."), calm.sampleRate).done;
await play(speech(voice, answer, { style: deliver("sad", 0.5) }), voice.sampleRate).done; // one call
```

Text with a style goes through its score, which sounds like the text read directly but differs
sample by sample. `plan` includes the voice's style, so a score it returned is not styled twice.
The pause between clauses follows `rate`, not a style's own pacing.

A function cannot be posted to a worker, so a worker voice and a speaker take a delivery as data
instead: `delivery`, a mood or numbers, and its `intensity`, when the voice is opened or for one
call. A worker voice speaks it exactly as a voice here speaks `style: deliver(...)`.

```ts
const voice = await createWorkerVoice({ body: "female", delivery: "calm" });
voice.say(answer, { delivery: "sad", intensity: 0.5 }); // this call only
```

## Singing

A song is lyrics on a melody, one note per syllable. It is planned into a score as text is, and
rendered the same way:

```ts
const song = {
  lyrics: "Twin-kle twin-kle lit-tle star",
  notes: [60, 60, 67, 67, 69, 69, 67].map((midi, i) => ({ midi, beats: i === 6 ? 2 : 1 })),
  bpm: 100,
  vibrato: 40, // cents, on held vowels
};
await play(voice.stream(song), voice.sampleRate).done;
const score = voice.plan(song); // the same score, to transform or inspect
```

Hyphens split a word's syllables as typed, and a lone `-` or `~` holds the previous vowel through
one more note. The first beat comes just after the first consonants, or at `t0` seconds to line
it up with an accompaniment. A song, like a score, refuses `rate`, `f0` and `accent`, and takes
only the style given with its call (`delivery` on a worker voice or a speaker). A speaker that
cannot sing (`supports.singing` is false: Kokoro, the device's voices) speaks the lyrics and says
`notes` in `lost`.

`intone/singing` has the rest of a singer's kit, all pure functions. `melody` writes notes as text,
`harmony` makes a second part for another voice, and `scoop` and `fall` slide into a note and off
the end of a phrase:

```ts
import { compose, createVoice, play } from "intone";
import { fall, harmony, melody, scoop } from "intone/singing";

const song = { lyrics: "sun-light on the wa-ter ~", notes: melody("C4 D4 E4 G4 A4 G4 C4:2"), bpm: 120 };
const style = compose(scoop(1, 0.09), fall(3, 0.25)); // semitones, seconds
await play(voice.stream(song, { style }), voice.sampleRate).done;

const third = harmony(song, "third-above"); // or third-below, fifth-below, octave-above, octave-below
```

A harmony keeps the lyrics and the rhythm, so it lasts exactly as long as the melody; give each part
its own voice. Thirds stay in the key, which is worked out from the notes (`keyOf`) or given
(`harmony(song, "third-above", { key: "Eb" })`, `"A minor"`). Two keys that cover a melody equally
are told apart by the note it ends on.

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

## Sound on phones

iOS mutes Web Audio with the silent switch and only starts audio from code running inside a tap.
`play` handles both when it is called from the tap. If your handler awaits something first, call
`unlockAudio(context)` at the top of it, or give `play` a context you resumed yourself.

## One interface, three backends

`intone/speaker` is one asynchronous interface that CHIMERA, Kokoro (a neural TTS model, run
locally through `kokoro-js`) and the device's own voices (Web Speech) all speak through, so an
app can switch backends without changing its call sites. Every call reports what that backend
could not honor in `lost`.

```ts
import { createSpeaker } from "intone/speaker";

const speaker = await createSpeaker("kokoro", { body: "female" });
speaker.id; // "kokoro"
speaker.supports; // { pitchCurve: false, soundTiming: false, breath: false, phones: true, ... }
const spoken = speaker.say("Hello there.");
spoken.lost; // what this call asked for that Kokoro could not do
await spoken.done;
speaker.free();
```

A `Speaker` describes itself (`accepts` the layer it reads, `supports`, `output`) and every
`render`/`stream`/`say` call reports `lost`, so a caller never has to know an engine's name to
degrade gracefully:

|              | accepts  | output   | honors                                  | typical `lost`                                 |
| ------------ | -------- | -------- | --------------------------------------- | ---------------------------------------------- |
| `chimera`    | gestures | samples  | everything (f0, accent, body, delivery) | nothing                                        |
| `kokoro`     | phrasing | samples  | rate, a delivery's rate                 | `f0`, `accent`, `body`, chunk size, the rest   |
| `web-speech` | intent   | playback | rate, a delivery's rate, pitch, level   | `f0`, `accent`, `body`, range, breath, tension |

A delivery's parts a backend cannot apply are named in `lost` ("pitch range", "breath"...), and
its rate multiplies the call's `rate`, or else the voice's own.

`createSpeaker("chimera", ...)` is a thin wrapper over `createWorkerVoice` and keeps its
guarantees (samples straight to the audio thread, `stop()` before anything plays gives silence).
`createSpeaker("kokoro", ...)` downloads the model on first use (about 88 MB) through `kokoro-js`,
which is an optional peer dependency: only code that imports `intone/speaker` and asks for
`"kokoro"` pulls it in.

## Imitating a voice

`intone/imitate` reads a recording and returns a small, plain-data profile for CHIMERA to speak
with: a caricature (pitch, its range, speaking rate, pauses, a formant-based body size, and a
rough breathiness), not a neural clone of the speaker. It is pure TypeScript with no engine
import, so it carries nothing of the rest of the package (see Cost, below).

```ts
import { profile } from "intone/imitate";

const p = profile(samples /* Float32Array, mono */, sampleRate, { speakerAgreed: true });
// p: { body, f0, rate, delivery: { range, breath, pauses }, measured: { ...raw numbers... } }
const voice = await createVoice({ body: p.body, f0: p.f0, rate: p.rate, style: deliver(p.delivery) });
```

`speakerAgreed` must be the literal `true`: a statement that the speaker agreed to be imitated
this way, not an audit. Getting that agreement, for whatever use the caller is putting it to, is
the caller's own responsibility; `profile()` only checks that the flag was explicitly set. No
recording of a real person is ever shipped in this repository; every test renders its own
CHIMERA audio.

`profile()` does not estimate timbre: it does not try to match a speaker's particular vocal
texture or resonance, only five coarse, independently measured dials. The mappings are fit
against CHIMERA's own renders (each constant in `src/imitate.ts` says how), and recovery degrades
honestly by parameter: pitch, its range, and the body-size estimate hold up well; speaking rate
and pauses need several seconds of actual speech to average out one sentence's own shape, and
read a short clip noisily; breathiness only distinguishes a clearly breathy voice from a clear
one, not fine shades near clear. See the round-trip tests in `src/imitate.test.ts` for the
measured numbers behind each of those claims.

## Letting a language model use the voice

`intone/tools` gives a model three tools: `say`, `sing` (lyrics on a melody written as text) and
`set_voice`. The definitions are JSON Schema, the same schema checks each call, and a bad call
comes back as a result the model can read and correct, never as an exception:

```ts
import { createSpeaker } from "intone/speaker";
import { createToolRunner, forAnthropic } from "intone/tools";

const speaker = await createSpeaker();
const tools = createToolRunner(speaker, { body: "female" });

const reply = await anthropic.messages.create({ model, messages, max_tokens, tools: forAnthropic() });
for (const block of reply.content) {
  if (block.type === "tool_use") {
    const result = await tools.run(block.name, block.input); // { ok: true, lost: [] } when it has finished
  }
}
tools.stop(); // the user interrupted: silence now, and drop the calls still waiting
```

`forOpenAI()` gives the same tools for Chat Completions, and `TOOLS` the neutral definitions. Calls
made at once speak one after the other. `lost` says what the backend could not do, such as `notes`
on one that cannot sing. It works on a `createWorkerVoice` too.

A melody is `melody("C4:1 D#4:0.5 Bb3:2")`: pitch and beats, one beat when left out, a MIDI number
accepted as a pitch, `|` ignored so it can be written in bars. A song has no silent notes, so a rest
is refused rather than dropped, which would move every later syllable onto the wrong note.

## Cost

|                                                | gzipped |
| ---------------------------------------------- | ------- |
| Engine (`intone_chimera.wasm`)                 | 221 KB  |
| JavaScript: `createVoice` alone                | 1.9 KB  |
| JavaScript: a chat (`speech`, `play`)          | 5.3 KB  |
| JavaScript: everything                         | 9.3 KB  |
| JavaScript: a voice in a Worker (both sides)   | 8.8 KB  |
| JavaScript: the device's voices only           | 2.7 KB  |
| JavaScript: `profile` (`intone/imitate`) alone | 2.6 KB  |
| JavaScript: tool calls (`intone/tools`)        | 2.7 KB  |
| JavaScript: songs (`intone/singing`)           | 2.0 KB  |
| Pronouncing dictionary (CMUdict, English)      | 869 KB  |

On an Apple M2, loading takes about 70 ms once per page, the first audible sample comes about
10 ms after asking, and one voice takes about a third of one core in real time. Phones have not
been measured yet. The rendering is deterministic: the same text and options always give the
same samples.

## Creatures

CHIMERA also models a few non-human airways: a songbird's two-voice syrinx, a seal's laryngeal
trill, an alligator's roar and an elephant's infrasonic rumble and trumpet. They render through a
second, smaller engine, `intone/creatures`, with no dependency on speech.

```ts
import { loadCreatures } from "intone/creatures";
import { play } from "intone";

const zoo = await loadCreatures();
const bird = zoo.create("songbird");
play([bird.call("flute")], zoo.sampleRate);
```

`call(id, { pitch, amp })` renders a whole call as a `Float32Array`, past its release tail;
`stream` gives the same samples as a generator, in chunks. `set({ ... })`, `gate(level)` and
`render(samples)` play a creature live, like an instrument.

| Creature              | Calls                              |
| --------------------- | ---------------------------------- |
| `songbird`            | `flute`, `trill`, `chirps`, `buzz` |
| `seal` (Weddell seal) | `trill`, `zap`, `whistle`, `chug`  |
| `alligator`           | `bellow`, `growl`, `hiss`, `dance` |
| `elephant`            | `rumble`, `trumpet`, `squeak`      |

## Intelligibility

Word errors made by two speech recognizers on sentences not used for tuning, over two voices. The
control is macOS `say`, which shows what a clear voice scores on the same test.

|                                 | Parakeet TDT 0.6b v3 | Whisper large-v3-turbo |
| ------------------------------- | -------------------- | ---------------------- |
| intone                          | 42.8 %               | 23.7 %                 |
| Control (macOS `say`, Samantha) | 2.3 %                | 2.6 %                  |

It is still hard to understand, and improving that is the current work. See
[eval/README.md](eval/README.md) for the method.

## How it stays in step with upstream

The engine is [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth) by Jameson Hodge, a
physical-modeling vocal synthesizer, kept in `crates/chimera` as a git subtree. The few changes it
carries here, each measured and meant for upstream, are listed in
[docs/upstream-patches.md](docs/upstream-patches.md).
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

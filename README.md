# Chimera Kit

A JavaScript library for speech that runs in the browser, starts in milliseconds and follows your
code down to the syllable. No neural weights or synthesis server.

[Live demos](https://chimerakit.dev) · [Get started](https://chimerakit.dev/docs#get-started) · [Documentation](https://chimerakit.dev/docs)

Chimera Kit is a JavaScript toolkit dedicated to [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth),
the physical voice model by [Jameson Hodge](https://github.com/jamesondh). Use its speech, singing,
live instrument, beatbox, creatures and real airway data in your app. The library handles browser
loading, workers, playback, interruption and streaming answers.

Every sound comes from a simulated airway. You can control each word's timing, pitch, breath and
articulation through plain-data scores. It sounds synthetic, and currently speaks English.

> **Status: 0.1 release candidate.** The first npm publication is being prepared. The API may change
> before 1.0. See the documentation for the current published version.

## Usage

```ts
import { createVoice, play } from "chimera-kit";

const voice = await createVoice({ body: "female" });
await play(voice.stream("The birch canoe slid on the smooth planks."), voice.sampleRate).done;
```

`play` starts with the first 128 samples and keeps a quarter of a second computed ahead of the
speakers; `stop()` or an `AbortSignal` cuts it short. Browsers keep audio suspended until the
page gets a click or a key press, so call it from one. The samples are computed on the calling
thread, about a third of one core while it speaks. To leave that thread free, run the voice in a
Worker: the same samples, the same calls, but `render` and `stream` are asynchronous.

```ts
import { createWorkerVoice } from "chimera-kit";

const voice = await createWorkerVoice({ body: "female" });
await voice.say("Hello there.").done;
const speech = voice.say(answer); // tokens as they arrive, spoken clause by clause
speech.stop(); // when the user interrupts
```

`say` sends the samples from the worker to the audio thread directly, so a busy page cannot make
the voice stutter. `stream` and `render` are there too, asynchronous.

The worker script is `chimera-kit/worker.js`, found next to the module with
`new URL("./worker.js", import.meta.url)`; pass `worker` to start it some other way.

The engine (`chimera.wasm`) and the dictionary (`cmudict.txt.gz`) are found next to the
module the same way. Vite and Next.js copy these files into the app's build; `bun build` does
not, so with it, serve them yourself and pass their URLs as `wasm` and `dictionary`.

Text that is still being written, such as a language model's answer, is spoken clause by clause
as it arrives. `speech` reads it as Markdown (code blocks are skipped, links read as their text)
and cuts it at punctuation and line ends:

```ts
import { play, speech } from "chimera-kit";

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
| `body`   | `"male"`, `"female"`, `"child"`, or any body: see [Any voice](#any-voice) |
| `rate`   | speaking-rate multiplier                                                  |
| `f0`     | baseline pitch in Hz                                                      |
| `accent` | pitch excursion on stressed syllables                                     |
| `style`  | a score transform for everything planned from text: `deliver("calm")`     |

`createVoice({ dictionary: false })` skips the pronouncing dictionary and uses spelling rules
alone, saving the 869 KB dictionary at a cost in pronunciation.

### Any voice

The three bodies are the calibrated points of a continuous space. A body can sit anywhere between
them and change from there: the airway's size, the throat's length, the tongue and the lips, and
the voice source's breathiness, tension, brightness, fry and roughness. Every field is optional.

```ts
const narrator = await createVoice({
  body: { female: 0.2, size: 1.08, pitch: -2, breathiness: 0.3, fry: 0.2 },
});
```

`bodyFromSeed` draws one from a number or a string, the same body every time: each user, agent or
character gets a voice of its own without anyone choosing a dozen settings.

```ts
import { bodyFromSeed } from "chimera-kit";

voice.render(message.text, { body: bodyFromSeed(message.author) });
```

There is nothing to download and the first sound still comes in milliseconds. Seeds draw where the
speech evaluation found the voices about as intelligible as the presets. Over eleven seeds, the mean word
error rate came out 4.3 points under the matched presets' with one recognizer and 2.3 under with
the other. One sentence still trips the second recognizer into a loop on one seed
(`eval/README.md`). A spec written by hand can go further, up to the
limits in `BodySpec`. A live instrument takes a blend only.

A physical model gives a kind of voice (deep, wide, breathy), not a person's: it clones nobody.

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

The prefix remains `6 + 2 * (pharynx + mouth + nose)` floats. A drawing suffix follows it:

- `geometryVersion` (currently 1), `hasFrame` (0 or 1).
- 17 current articulation values: `jaw, tbX, tbY, ttX, ttY, ttCurl, root, lipAp, lipProt,
  lipWidth, labiodental, velum, larynx, epilarynx, ventricular, lateral, dorsum`.
- Four body dimensions: `scale, pharynx, tongueRadius, lipWidth`.
- When `hasFrame` is 1: point counts for `outer, inner, tongue, velum, upperLip, lowerLip,
  upperTeeth, lowerTeeth, jawBone, epiglottis, nasalCavity`, then the grid sample count.
- 14 frame scalars: `glottis.x, glottis.y, length, pharynxLength, teethS, lipS, velumPort,
  lipArea, tongueCenter.x, tongueCenter.y, tongueRadius, tip.x, tip.y, splitIndex`.
- The outlines' `x, y` pairs in count order, then each grid sample as `inner.x, inner.y,
  outer.x, outer.y, mid.x, mid.y, d, area, s, region, ray`.

Coordinates and distances are cm, areas cm². `region` is 0 (epilarynx), 1 (pharynx),
2 (oral), or 3 (front); `splitIndex` is the first oral grid sample, or -1. The data comes
from the engine's retained geometry at the end of the chunk. Drawing it neither guesses
mouth shapes from text nor runs another voice model. Keep only frames needed for playback.

### Shaping one reading

`plan` gives the score the voice would speak: every sound with its timing, the pitch, and where
each word lies. Change it, then render the score itself, timing and pitch kept to the sample:

```ts
import { take } from "chimera-kit";

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
import { deliver, speech } from "chimera-kit";

const calm = await createVoice({ body: "female", style: deliver("calm") });
await play(calm.stream("Take a breath."), calm.sampleRate).done;
await play(speech(voice, answer, { style: deliver("sad", 0.5) }), voice.sampleRate).done; // one call
```

Text with a style goes through its score, which sounds like the text read directly but differs
sample by sample. `plan` includes the voice's style, so a score it returned is not styled twice.
The pause between clauses follows `rate`, not a style's own pacing.

A function cannot be posted to a worker, so a worker voice takes a delivery as data
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
only the style given with its call (`delivery` on a worker voice).

`chimera-kit/singing` has the rest of a singer's kit, all pure functions. `melody` writes notes as text,
`harmony` makes a second part for another voice, and `scoop` and `fall` slide into a note and off
the end of a phrase:

```ts
import { compose, createVoice, play } from "chimera-kit";
import { fall, harmony, melody, scoop } from "chimera-kit/singing";

const song = { lyrics: "sun-light on the wa-ter ~", notes: melody("C4 D4 E4 G4 A4 G4 C4:2"), bpm: 120 };
const style = compose(scoop(1, 0.09), fall(3, 0.25)); // semitones, seconds
await play(voice.stream(song, { style }), voice.sampleRate).done;

const third = harmony(song, "third-above"); // or third-below, fifth-below, octave-above, octave-below
```

A harmony keeps the lyrics and the rhythm, so it lasts exactly as long as the melody; give each part
its own voice. Thirds stay in the key, which is worked out from the notes (`keyOf`) or given
(`harmony(song, "third-above", { key: "Eb" })`, `"A minor"`). Two keys that cover a melody equally
are told apart by the note it ends on.

## Sound on phones

iOS mutes Web Audio with the silent switch and only starts audio from code running inside a tap.
`play` handles both when it is called from the tap. If your handler awaits something first, call
`unlockAudio(context)` at the top of it, or give `play` a context you resumed yourself.

## Imitating a voice

`chimera-kit/imitate` reads a recording and returns a small, plain-data profile for CHIMERA to speak
with: a caricature (pitch, its range, speaking rate, pauses, a formant-based body blend, the
voice's brightness and, when it is clearly breathy, its breathiness), not a neural clone of the
speaker. It is pure TypeScript with no engine import, so it carries nothing of the rest of the
package (see Cost, below).

```ts
import { profile } from "chimera-kit/imitate";

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
texture or resonance, only a few coarse, independently measured dials. The mappings are fit
against CHIMERA's own renders (each constant in `src/imitate.ts` says how), and recovery degrades
honestly by parameter: pitch, its range, and the body blend hold up well; speaking rate and
pauses need several seconds of actual speech to average out one sentence's own shape, and read a
short clip noisily; brightness comes back within about 0.1 on each body; breathiness is only set
for a clearly breathy voice (a clear one keeps the body's own), and a rough voice reads as breathy.
The airway's size, fry and tension are not measured. See the round-trip tests in
`src/imitate.test.ts` for the measured numbers behind each of those claims.

## Letting a language model use the voice

`chimera-kit/tools` gives a model three tools: `say`, `sing` (lyrics on a melody written as text) and
`set_voice`. The definitions are JSON Schema, the same schema checks each call, and a bad call
comes back as a result the model can read and correct, never as an exception:

```ts
import { createWorkerVoice } from "chimera-kit";
import { createToolRunner, forAnthropic } from "chimera-kit/tools";

const voice = await createWorkerVoice();
const tools = createToolRunner(voice, { body: "female" });

const reply = await anthropic.messages.create({ model, messages, max_tokens, tools: forAnthropic() });
for (const block of reply.content) {
  if (block.type === "tool_use") {
    const result = await tools.run(block.name, block.input); // { ok: true } when it has finished
  }
}
tools.stop(); // the user interrupted: silence now, and drop the calls still waiting
```

`forOpenAI()` gives the same tools for Chat Completions, and `TOOLS` the neutral definitions. Calls
made at once speak one after the other. The worker voice supports speech and singing directly.

A melody is `melody("C4:1 D#4:0.5 Bb3:2")`: pitch and beats, one beat when left out, a MIDI number
accepted as a pitch, `|` ignored so it can be written in bars. A song has no silent notes, so a rest
is refused rather than dropped, which would move every later syllable onto the wrong note.

## Cost

|                                                     | gzipped |
| --------------------------------------------------- | ------- |
| Engine (`chimera.wasm`)                             | 274 KB  |
| JavaScript: `createVoice` alone                     | 2.1 KB  |
| JavaScript: a chat (`speech`, `play`)               | 5.5 KB  |
| JavaScript: everything                              | 10.1 KB |
| JavaScript: a voice in a Worker (both sides)        | 9.6 KB  |
| JavaScript: `profile` (`chimera-kit/imitate`) alone | 2.9 KB  |
| JavaScript: tool calls (`chimera-kit/tools`)        | 2.7 KB  |
| JavaScript: songs (`chimera-kit/singing`)           | 2.1 KB  |
| Pronouncing dictionary (CMUdict, English)           | 869 KB  |

On an Apple M2, loading takes about 70 ms once per page, the first audible sample comes about
10 ms after asking, and one voice takes about a third of one core in real time. Phones have not
been measured yet. The rendering is deterministic: the same text and options always give the
same samples.

## Creatures

CHIMERA also models a few non-human airways: a songbird's two-voice syrinx, a seal's laryngeal
trill, an alligator's roar and an elephant's infrasonic rumble and trumpet. They render through a
second, smaller engine, `chimera-kit/creatures`, with no dependency on speech.

```ts
import { loadCreatures } from "chimera-kit/creatures";
import { play } from "chimera-kit";

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

## A played voice

`chimera-kit/live` holds a note instead of speaking a sentence: press it on, move the mouth and the
source while it sounds, bend its pitch, release it. It runs inside an AudioWorklet, so a control
call reaches the audio thread without a hop through the page's own event loop. The beatbox CHIMERA
already models (kick, snare, hats, clicks, a hummed bass) comes along as `live.beat`.

```ts
import { createInstrument } from "chimera-kit/live";

const context = new AudioContext();
const live = await createInstrument({ body: "female", context });

live.vowel("a");
live.noteOn(60); // sounds within a render quantum or two
live.shape({ jaw: 0.4, lipAp: 0.2 }); // the engine's own articulator names
live.source({ breathiness: 0.3, tension: 0.6 });
live.bend(62); // glides without retriggering
live.noteOff();

live.beat.steps("kick . snare ."); // names or pattern symbols ("B . Pf .") both work
live.beat.start({ bpm: 96 });
live.beat.hit("kick"); // one hit, outside the sequencer
live.beat.stop();

live.telemetry(); // the worklet's last snapshot: f0, gate, the airway's areas, ...
live.free();
```

A call the engine rejects (an unknown vowel, a non-finite value, an unknown beat sound) cannot
throw back at the caller the way a direct function call would, since it crosses to the audio
thread as a message: pass `onError` to `createInstrument` to hear about it. The engine itself is
left exactly as it was.

## Intelligibility

Word errors made by two speech recognizers on sentences not used for tuning, over two voices. The
control is macOS `say`, which shows what a clear voice scores on the same test.

|                                 | Parakeet TDT 0.6b v3 | Whisper large-v3-turbo |
| ------------------------------- | -------------------- | ---------------------- |
| chimera-kit                     | 42.8 %               | 23.7 %                 |
| Control (macOS `say`, Samantha) | 2.3 %                | 2.6 %                  |

It is still hard to understand, and improving that is the current work. See
`eval/README.md` for the method.

## How it stays in step with upstream

The engine is [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth) by Jameson Hodge, a
physical-modeling vocal synthesizer, kept in `crates/chimera` as a git subtree. The few changes it
carries here, each measured and meant for upstream, are listed in
`docs/upstream-patches.md`.
`bun run sync-upstream` merges new upstream work in. Everything specific to this package lives in
`crates/intone-chimera` and `src/`.

## Where it is going

Complete browser access to Chimera: speech, scores, singing, live voices, beatbox and creatures. See
`docs/design.md`.

## Contributing

See `CONTRIBUTING.md`. The evaluation harness and its rules are in
`eval/README.md`.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.

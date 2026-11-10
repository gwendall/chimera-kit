# Design

intone is one small API for every voice a program needs: speech with a chosen delivery, singing,
and sounds that are not words, from any engine, local first. This document is the plan the code
grows into. Where the code and this file disagree, the code is right and this file gets fixed.

## Principles

1. **Layers of plain data.** A request goes down five layers, each a JSON-serializable value that
   compiles into the one below. A program can enter at any layer, read the result of any layer,
   edit it and hand it back.
2. **Pure transforms.** A delivery (slower, sadder, a word stressed) is a function from one value
   of a layer to another value of the same layer. Transforms compose; emotions are compositions.
3. **A voice is data too.** It holds a default for every layer it touches: a body at the bottom,
   a source in the middle, speaking habits at the top.
4. **Engines say what they accept.** Each engine takes one layer. The core computes everything
   above it. What an engine cannot honor is reported, never dropped in silence.
5. **Streaming first.** Every step works on a prefix of the input. The first sample must come
   within milliseconds, and text may arrive token by token from a language model.
6. **A small core.** The core holds no engine and no data tables. Each engine is a separate
   import, and its weight is paid only by those who use it.

## The layers

| Layer | Name     | Holds                                                        | Made by                  |
| ----- | -------- | ------------------------------------------------------------ | ------------------------ |
| 4     | Intent   | text, or a named sound, with a style                         | the program              |
| 3     | Phrasing | words, syllables, phonemes, stress, emphasis, phrase breaks  | a language frontend      |
| 2     | Score    | timed sounds, and pitch, loudness, breath and tension curves | a prosody model          |
| 1     | Gestures | articulator targets over time, on one body of one engine     | the engine's planner     |
| 0     | Signal   | samples                                                      | the engine's synthesizer |

A melody is a phrasing too: lyrics, notes and beats. It compiles to the same score as speech,
which is why one score format serves both.

### 4. Intent

```ts
type Intent =
  | string
  | { text: string; style?: Style | StyleName; lang?: string }
  | { call: string; pitch?: Pitch; length?: number; intensity?: number };
```

`call` names a sound that is not a word: `"meow"`, `"laugh"`, `"gasp"`, `"growl"`. What it becomes
depends on the body (see the third example).

### 3. Phrasing

```ts
interface Phrasing {
  lang: string;
  phrases: Phrase[];
}
interface Phrase {
  words: Word[];
  end: "none" | "comma" | "period" | "question" | "exclamation";
  pause: number; // seconds of silence after the phrase
}
interface Word {
  text: string;
  syllables: { phones: string[]; stress: 0 | 1 | 2 }[]; // phones in IPA
  emphasis: number; // 0 plain, 1 strongest
}

interface Melody {
  lang: string;
  bpm: number;
  notes: { lyric: string; phones?: string[]; pitch: Pitch; beats: number; slur?: boolean }[];
}
```

IPA is the lingua franca: an adapter whose engine uses another alphabet maps it.

### 2. Score

```ts
interface Score {
  duration: number; // seconds
  sounds: { sound: string; t0: number; t1: number; stress?: 0 | 1 | 2 }[];
  pitch: Curve; // Hz
  loudness?: Curve; // dB relative to the voice's level
  breath?: Curve; // 0 clean, 1 all air
  tension?: Curve; // 0 lax, 1 pressed
  words?: { text: string; t0: number; t1: number }[];
}
type Curve = [seconds: number, value: number][]; // linear between points, held past the ends
```

`sound` is an IPA phone, `"_"` for silence, or a sound the body defines. `words` is there so that
a program can select a word by its text and so that a player can report word boundaries.

The score is the layer where a program gets exact control: a word lasts what it says, the pitch
follows the curve. It is also the layer that a test can check, by measuring the rendered pitch and
the timing against the request.

### 1. Gestures

Articulator targets over time: tongue, lips, velum, glottis, for one engine's model of one body.
There is no portable standard at this level, so the type is the engine's own
(`Gestures<"chimera">`). The core moves gestures in time and passes them through, without reading
them. This layer is for the precise consonant, the scream, the creature call.

### 0. Signal

```ts
interface Signal {
  sampleRate: number;
  chunks: AsyncIterable<Float32Array>;
}
```

Some engines never hand out samples (the browser's own speech plays to the speakers). They return
a playback handle instead, with the same events.

## Voices

```ts
interface VoiceSpec {
  body: Body; // "male" | "female" | "child", a BodySpec anywhere in the voice space, a creature, or an engine's voice id
  source?: { f0?: number; range?: number; breath?: number; tension?: number }; // layer 2 defaults
  habits?: { rate?: number; pauses?: number; emphasis?: number; reduction?: number }; // layer 3 defaults
  lang?: string;
}
```

A voice spec is a few hundred bytes of JSON: it can be stored, shared and versioned with a game's
other assets. Presets are specs. An engine that has fixed voices (Kokoro's `af_heart`) takes the
voice id as its body and approximates the rest, as with anything else it cannot honor.

## Styles and transforms

```ts
type PhrasingTransform = (p: Phrasing) => Phrasing;
type ScoreTransform = (s: Score, scope?: { t0: number; t1: number }) => Score;
interface Style {
  phrasing?: PhrasingTransform[];
  score?: ScoreTransform[];
}

const tired: Style = {
  phrasing: [longerPauses(1.4), lessEmphasis(0.5)],
  score: [rate(0.85), shift("-2st"), range(0.6), breathier(0.3)],
};
```

The basic transforms (`src/transforms.ts`): `stretch`, `rate`, `shift` (semitones or cents), `range`
(pitch excursions), `gain`, `breathier`, `tenser`, `pauseAt`, `emphasize`, and `compose`. A scoped transform ramps in and out
over 30 ms so that an edit never clicks. Stretching a span shifts everything after it.

Named moods are deliveries (`src/delivery.ts`): plain numbers for rate, pitch, range, level,
breath, tension and pauses, applied at an intensity with `deliver("sad", 0.6)`. They are
starting points, written down in a table that anyone can read and change, not a model.

## The API

```ts
const voice = await createVoice({ body: "female", habits: { rate: 1.1 } });

await voice.say("Hello there."); // plays it; resolves when done
for await (const chunk of voice.stream("Hello there.")) player.push(chunk); // samples

const take = voice.plan("I told you. Never come back here.", { style: "cold" }); // layers 3 and 2
take.word("never").emphasize(1).pitch("+2st");
take.word("you").pauseAfter(0.6);
await voice.say(take);

await voice.say(llm.tokens()); // AsyncIterable<string>: speaks clause by clause as text arrives
```

`plan` returns a take: the phrasing and the score, as data, with helpers that select a word or a
span and apply transforms to it. `take.score` and `take.phrasing` are the plain values; editing
them by hand is as legitimate as using the helpers.

`say`, `stream` and `plan` accept any layer: a string, an intent, a phrasing, a melody, a score,
or an engine's gestures.

## Engines

```ts
interface Engine {
  id: string;
  accepts: "intent" | "phrasing" | "score" | "gestures";
  supports: {
    pitchCurve: boolean;
    soundTiming: boolean;
    breath: boolean;
    phones: boolean;
    langs: string[];
    bodies: string[];
  };
  output: "samples" | "playback";
  sampleRate?: number;
  open(voice: VoiceSpec): Promise<EngineVoice>;
}
```

The core lowers a request to the engine's layer with a language frontend (text to phrasing) and
a prosody model (phrasing to score). When the request is below the engine's layer, the core lifts
it, and that loses information: a score handed to an engine that only takes text keeps its words
and its average pitch and rate per phrase.

Every render says what it dropped (`rendered.lost: ["pitch curve", "word timing"]`). With
`{ fidelity: "strict" }` the render throws instead.

The three engines this design was checked against:

|          | CHIMERA                           | Kokoro (`kokoro-js`)                  | Web Speech (`speechSynthesis`)  |
| -------- | --------------------------------- | ------------------------------------- | ------------------------------- |
| Accepts  | gestures (layer 1)                | phonemes: a phrasing without timing   | text (layer 4)                  |
| Pitch    | any curve                         | none: one style vector per call       | one value per utterance, 0 to 2 |
| Timing   | each sound                        | one `speed` per call                  | one `rate` per utterance        |
| Output   | samples, 48 kHz, 128 at a time    | samples, 24 kHz, a sentence at a time | playback only                   |
| Download | 188 KB, plus 869 KB of dictionary | 82 M parameters: tens of MB           | none                            |
| Voices   | bodies and blends, creatures      | fixed voices (28 in English)          | the system's                    |

Sources: `kokoro-js` exposes `generate(text, { voice, speed })`, `stream(text, ...)` yielding
`{ text, phonemes, audio }`, and `generate_from_ids(input_ids, { voice, speed })`; the model's
inputs are `input_ids`, `style` and `speed`, and `SAMPLE_RATE = 24000`. Phonemes can reach it
through `generate_from_ids`, once the adapter tokenizes them.

Today the language frontend and the prosody model are CHIMERA's (English rules and CMUdict, in
Rust). They will be exposed from the same wasm as separate calls, typed by the core's layers, so
that other engines can use them too.

## Three examples, checked on paper

### A line of dialogue

```ts
const take = voice.plan("I told you. Never come back here.", { style: "cold" });
take.word("never").emphasize(1).pitch("+2st");
take.word("you").pauseAfter(0.6);
await voice.say(take);
```

The frontend makes two phrases; `cold` lengthens pauses and flattens emphasis on the phrasing,
then lowers and narrows the pitch on the score. The edits act on the score.

- **CHIMERA** honors all of it. It needs one thing it does not have yet in this package: a score
  as input. The lab already plans a voice from timed phones and a pitch curve (`Performance` in
  `chimera-lab/crates/chimera-cli/src/performance.rs`); that port is the next engine lot. The
  reverse, a score from CHIMERA's own plan, comes from the plan's timed segments and from
  sampling its `F0` and `Breath` controls.
- **Kokoro** renders each phrase with its own call, its phonemes mapped from IPA and its `speed`
  set from the phrase's mean rate, and the core inserts the pauses as silence. Lost: the pitch
  edit and the word's length, because Kokoro has no pitch input and no per-sound timing.
- **Web Speech** speaks two utterances, each with the phrase's rate and mean pitch, the pause
  timed between them by the player. Lost: the pitch curve, the word edits and the phonemes.

### A sung phrase

```ts
await voice.say({
  lang: "en",
  bpm: 90,
  notes: [
    { lyric: "Lights", pitch: "E4", beats: 1 },
    { lyric: "go", pitch: "G4", beats: 1 },
    { lyric: "down", pitch: "A4", beats: 2 },
  ],
});
```

- **CHIMERA** sings it. Its `plan_song` takes notes (`SungNote { midi, beats, syl }`) with a body,
  a tempo and vibrato (`SongOptions`), places onset consonants before the beat so each vowel lands
  on it, and squeezes consonants in fast runs.
- **Kokoro** and **Web Speech** cannot sing: they have no pitch input. Strict mode throws; the
  approximate mode speaks the lyrics in rhythm and reports `lost: ["melody"]`.

### A meow

```ts
await voice.say({ call: "meow", pitch: "A5", length: 0.8 });
```

A call means two different things depending on the body.

- On a **human** body, a call is a person imitating the sound: a recipe that writes a score.
  `meow` becomes `m i a ʊ` with a pitch that rises then falls and a swell in loudness. Any engine
  that takes a score can render it, CHIMERA included. Kokoro gets the phonemes without the glide,
  and Web Speech gets the word "meow".
- On a **creature** body, a call is the animal's own gesture: named keys over the creature's
  parameters (a gate, a pitch, a tension). That is layer 1, CHIMERA only. Upstream CHIMERA ships
  a songbird (`trill`, `chirps`, `buzz`), a seal, an alligator (`growl`, `dance`) and an
  elephant; the cat exists only in the lab so far.

## Streaming and latency

- Text that arrives in pieces is cut at clause boundaries: a clause starts as soon as its
  punctuation arrives, or after eight words without any. Planning a clause takes 0.2 ms with
  CHIMERA, so a clause cut too early is planned again with its context.
- On an Apple M2, CHIMERA's first audible sample comes 6.5 ms after the request, and a voice uses
  about 30 % of one core. Phones are not measured yet.
- In a browser, a Worker renders and an AudioWorklet plays from a ring buffer (shared memory when
  the page is cross-origin isolated, messages otherwise).

## Packaging

- `intone`: the layers' types, transforms, takes, the compiler, the scheduler, and `createVoice`,
  which loads the default engine with a dynamic import so that bundlers keep it separate.
- `intone/chimera`: the adapter and its wasm. `intone/en`: the English dictionary, optional.
- `intone/kokoro` (with `kokoro-js` as a peer dependency) and `intone/web-speech`.
- Later: a React Native module over the platforms' own speech (`AVSpeechSynthesizer`, Android's
  `TextToSpeech`), which cannot run from JavaScript alone.

## Imitating a voice

Two different things go by "cloning":

- **A profile**: a voice spec estimated from a recording: pitch and range, speaking rate, pauses,
  vocal tract length (from the formants), breathiness. A few kilobytes, rendered by CHIMERA. It is
  a caricature of the person, not a copy.
- **A clone**: a neural engine's speaker embedding. Faithful, but tied to that engine and to a
  model of tens or hundreds of megabytes.

Both live in a separate module, `intone/imitate`, whose functions take an explicit statement that
the speaker agreed. No recording of a real person goes in this repository.

## Evaluation is part of the product

The harness grades every engine on the same tests: words understood by two recognizers, pitch and
timing that follow the request (measured on the render, in cents and milliseconds), latency to
the first sample, download size, and processor load. Each release publishes that table, so that
a user can choose an engine on numbers.

## Limits

- Layer 1 has no portable form; code written there is tied to one engine.
- CHIMERA's prosody is a set of rules. A neural engine's own prosody is usually better, so for
  Kokoro the default entry is the phrasing, not the score.
- CHIMERA's inventory is tuned for English. Other languages need a frontend each, and sounds the
  inventory lacks (French nasal vowels, /y/).

## Order of work

1. Intelligibility of the engine, measured by the harness.
2. A score as CHIMERA input and output through the ABI; `plan` and takes with word selection and
   the basic transforms; a conformance test that measures pitch and timing on the render.
3. The engine interface above, with `accepts`, `supports`, `output` and the `lost` report.
4. Adapters for Web Speech and Kokoro.
5. The browser player and text that arrives token by token.
6. Styles, emotions and voice presets.
7. Melodies and calls.
8. Voice profiles.
9. Other languages.

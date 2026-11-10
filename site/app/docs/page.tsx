import type { Metadata, ResolvingMetadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/CodeBlock";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { LINKS, RELEASE } from "@/lib/links";
import styles from "./page.module.css";

export async function generateMetadata(_props: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  const inherited = await parent;
  const title = "Documentation | intone";
  const description =
    "Install intone, speak your first sentence, stream an answer, direct a voice and sing. A JavaScript speech library for the browser.";
  return {
    title,
    description,
    alternates: { canonical: "/docs" },
    openGraph: {
      type: "website",
      siteName: "intone",
      title,
      description,
      url: "/docs",
      images: inherited.openGraph?.images ?? [],
    },
    twitter: { card: "summary_large_image", title, description, images: inherited.twitter?.images ?? [] },
  };
}

const sections = [
  ["get-started", "Get started"],
  ["direction", "Voices & direction"],
  ["streaming", "Streaming answers"],
  ["singing", "Singing"],
  ["tools", "Agent tools"],
  ["backends", "Worker playback"],
  ["more", "Live voices & creatures"],
  ["reference", "API reference"],
  ["troubleshooting", "Troubleshooting"],
] as const;

const entrypoints = [
  [
    "intone",
    "createVoice, createWorkerVoice, play, speech, take, deliver, bodyFromSeed",
    "Speech, playback and score direction.",
  ],
  ["intone/singing", "melody, harmony, keyOf, scoop, fall", "Notes, harmonies and singing transforms."],
  [
    "intone/tools",
    "TOOLS, createToolRunner, forAnthropic, forOpenAI",
    "Validated say, sing and set_voice tool calls.",
  ],
  ["intone/live", "createInstrument", "A sustained voice and beat sequencer in an AudioWorklet."],
  ["intone/creatures", "loadCreatures", "A separate engine for birds, seals, alligators and elephants."],
  ["intone/imitate", "profile", "Coarse voice measurements from a mono recording."],
];

export default function Docs() {
  return (
    <>
      <SiteHeader docs />
      <main id="main" className={`wrap ${styles.layout}`}>
        <aside className={styles.sidebar}>
          <Link href={LINKS.home} className={styles.back}>
            ← Try the live demos
          </Link>
          <nav aria-label="Documentation sections">
            <span className="label">On this page</span>
            {sections.map(([id, title]) => (
              <a key={id} href={`#${id}`}>
                {title}
              </a>
            ))}
          </nav>
        </aside>
        <article className={styles.article}>
          <div className={styles.intro}>
            <span className="label">Developer documentation</span>
            <h1>A voice in your code.</h1>
            <p className="lead">
              intone is a JavaScript library for speech in the browser. Speak a sentence, stream an answer, or
              control the timing and pitch of each word. The default engine runs locally with WebAssembly.
            </p>
          </div>

          <section id="get-started">
            <h2>Get started</h2>
            <div className={styles.notice}>
              {RELEASE.npmVersion ? (
                <>
                  Available on{" "}
                  <a href={LINKS.npm}>
                    npm as {RELEASE.name}@{RELEASE.npmVersion}
                  </a>
                  .
                </>
              ) : (
                <>
                  The library is in private preview. The npm release is coming next. These examples document
                  the current API; the install command becomes available with the first release.{" "}
                  <Link href={LINKS.examples}>Try it in the browser today.</Link>
                </>
              )}
            </div>
            <h3>1. Add the package</h3>
            <CodeBlock language={RELEASE.npmVersion ? "Terminal" : "Terminal · after the first npm release"}>
              {"npm install intone"}
            </CodeBlock>
            <p>
              Use a browser app with ES modules, such as Vite or Next.js. In Next.js, keep voice creation and
              playback in client code. Load the voice once, then start playback from a click or tap.
            </p>
            <h3>2. Speak on a click</h3>
            <CodeBlock language="HTML">{'<button id="speak">Speak</button>'}</CodeBlock>
            <CodeBlock>{`import { createVoice, play } from "intone";

const voice = await createVoice({ body: "female" });

document.querySelector("#speak")?.addEventListener("click", () => {
  const playback = play(voice.stream("Hello there."), voice.sampleRate);
  // playback.stop() interrupts immediately.
  playback.done.then(() => console.log("Finished"));
});`}</CodeBlock>
            <p>
              <code>play()</code> returns a playback handle with <code>stop()</code> and <code>done</code>.
              Reuse the voice for later sentences. Call <code>voice.free()</code> when your app no longer
              needs it, after playback finishes.
            </p>
            <h3>3. Choose how much control you need</h3>
            <p>
              Use <code>voice.stream(text)</code> for audio chunks, <code>voice.render(text)</code> for a
              complete <code>{"{ audio, sampleRate }"}</code> result, or <code>voice.plan(text)</code> for an
              editable score. The engine sounds synthetic and currently speaks English.
            </p>
          </section>

          <section id="direction">
            <h2>Voices & direction</h2>
            <p>
              Start with <code>male</code>, <code>female</code> or <code>child</code>. A body can also be a
              blend with physical and source settings. A seed gives each character the same voice every time.
            </p>
            <CodeBlock>{`import { bodyFromSeed, createVoice, deliver, play, take } from "intone";

const voice = await createVoice({
  body: bodyFromSeed("guide"),
  style: deliver("calm"),
});

const reading = take(voice.plan("I never said she stole my money."));
reading.word("never").emphasize();
reading.word("money").pitch("+2st").stretch(1.3);

play(voice.stream(reading.score), voice.sampleRate);`}</CodeBlock>
            <p>
              Text accepts <code>rate</code>, baseline pitch <code>f0</code> in Hz, and stress excursion{" "}
              <code>accent</code>. Scores and songs already contain timing and pitch, so those three options
              are refused. Use score transforms such as <code>stretch</code>, <code>shift</code> and{" "}
              <code>deliver</code> instead.
            </p>
          </section>

          <section id="streaming">
            <h2>Streaming answers</h2>
            <p>
              Pass an async iterable of text tokens to <code>speech()</code>. It speaks clause by clause,
              skips Markdown code blocks and reads links as their text. The following example reuses a loaded{" "}
              <code>voice</code>; <code>tokens</code> is your application's token stream.
            </p>
            <CodeBlock>{`import { play, speech } from "intone";

const playback = play(speech(voice, tokens), voice.sampleRate);
// When the user interrupts:
playback.stop();
await playback.done;`}</CodeBlock>
            <p>
              For a busy interface, use a worker voice and call <code>voice.say(tokens)</code>. It sends
              samples directly from the worker to the audio thread. Call playback from a user gesture, or
              unlock your audio context before awaiting a network response.
            </p>
          </section>

          <section id="singing">
            <h2>Singing</h2>
            <p>
              A song pairs one note with each syllable. Hyphens split syllables inside a word. A standalone{" "}
              <code>~</code> or <code>-</code> holds the previous vowel through another note.
            </p>
            <CodeBlock>{`import { createVoice, play } from "intone";
import { harmony, melody } from "intone/singing";

const voice = await createVoice();
const song = {
  lyrics: "Hel-lo there",
  notes: melody("C4 D4 E4:2"),
  bpm: 110,
  vibrato: 30, // cents on held vowels
};
const playback = play(voice.stream(song), voice.sampleRate);
const upperPart = harmony(song, "third-above");
// Give upperPart its own voice for simultaneous harmony.
// Call playback.stop() to end the song.`}</CodeBlock>
            <p>
              Notes use pitch and optional duration in beats: <code>C4:1 D#4:0.5 Bb3:2</code>. MIDI numbers
              are accepted; <code>|</code> is ignored. Silent rests are currently refused. <code>scoop</code>{" "}
              and <code>fall</code> add pitch slides to a score.
            </p>
          </section>

          <section id="tools">
            <h2>Agent tools</h2>
            <p>
              Expose <code>say</code>, <code>sing</code> and <code>set_voice</code> to a language model. The
              runner validates arguments, speaks concurrent calls in order, and returns readable success or
              error data.
            </p>
            <CodeBlock>{`import { createWorkerVoice } from "intone";
import { createToolRunner, forAnthropic, forOpenAI } from "intone/tools";

const voice = await createWorkerVoice();
const runner = createToolRunner(voice, { body: "female" });

const result = await runner.run("say", { text: "Hello there." });
// { ok: true }, or { ok: false, error: "..." }

const anthropicTools = forAnthropic();
const chatCompletionsTools = forOpenAI();
// Pass the appropriate definitions to your model provider.
// Send each returned tool name and arguments to runner.run().

runner.stop(); // Interrupt audio and discard queued calls.
voice.free();`}</CodeBlock>
            <p>
              The adapters provide tool definitions, not model API clients. <code>forOpenAI()</code> returns
              the Chat Completions tool format. <code>TOOLS</code> contains provider-neutral JSON Schema
              definitions. Calls run against the Chimera voice and return when playback finishes.
            </p>
          </section>

          <section id="backends">
            <h2>Worker playback</h2>
            <p>
              A worker keeps Chimera synthesis off the main thread. Its <code>render</code> and{" "}
              <code>stream</code> methods are asynchronous; <code>say</code> returns a playback handle
              immediately.
            </p>
            <CodeBlock>{`import { createWorkerVoice } from "intone";

const voice = await createWorkerVoice({ body: "female", delivery: "calm" });
const playback = voice.say("Take a breath.");
await playback.done;
voice.free();`}</CodeBlock>
            <p>
              Workers take <code>delivery</code> and <code>intensity</code> as data instead of a{" "}
              <code>style</code> function. They accept text, songs and edited scores, with samples sent
              directly to the audio thread. Call <code>playback.stop()</code> to interrupt and{" "}
              <code>voice.free()</code> on teardown.
            </p>
          </section>

          <section id="more">
            <h2>Live voices & creatures</h2>
            <p>
              <code>intone/live</code> is an AudioWorklet instrument. Create it with an unlocked audio
              context, then use <code>vowel("a")</code>, <code>noteOn(60)</code>, <code>bend(62)</code>,{" "}
              <code>shape({"{ jaw: 0.4 }"})</code> and <code>noteOff()</code>. Its <code>beat</code> sequencer
              handles kicks, snares and hats. Call <code>free()</code> on teardown.
            </p>
            <p>
              <code>intone/creatures</code> loads a separate engine. Call <code>loadCreatures()</code>, create
              a creature with <code>zoo.create("songbird")</code>, and play <code>bird.call("flute")</code> at{" "}
              <code>zoo.sampleRate</code>. Free the creature when finished.
            </p>
            <p>
              <code>intone/imitate</code> measures pitch, rate and a coarse body profile from mono audio:{" "}
              <code>profile(samples, sampleRate, {"{ speakerAgreed: true }"})</code>. It requires the
              speaker's agreement and produces a caricature, with no neural voice cloning.
            </p>
            <p>
              <Link href="/#more">Explore the instrument and creatures demos →</Link>
            </p>
          </section>

          <section id="reference">
            <h2>API reference</h2>
            <p>
              Each entry point ships TypeScript declarations. Import the Chimera features your app needs;
              creatures load their own small WASM artifact.
            </p>
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>Import</th>
                    <th>Exports</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {entrypoints.map(([path, names, purpose]) => (
                    <tr key={path}>
                      <td>
                        <code>{path}</code>
                      </td>
                      <td>
                        <code>{names}</code>
                      </td>
                      <td>{purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Voice & playback</h3>
            <dl className={styles.reference}>
              <div>
                <dt>
                  <code>createVoice(options?) → Promise&lt;Voice&gt;</code>
                </dt>
                <dd>
                  Loads the engine once per voice. Options include body, rate, f0, accent, style, wasm and
                  dictionary.
                </dd>
              </div>
              <div>
                <dt>
                  <code>voice.plan(text | song) → Score</code>
                </dt>
                <dd>Returns sounds, timing, pitch curves and word spans for inspection or editing.</dd>
              </div>
              <div>
                <dt>
                  <code>voice.render(text | song | score, options?)</code>
                </dt>
                <dd>
                  Returns <code>{"{ audio: Float32Array, sampleRate: number }"}</code>.
                </dd>
              </div>
              <div>
                <dt>
                  <code>voice.stream(text | song | score, options?)</code>
                </dt>
                <dd>
                  Yields audio chunks. The main-thread voice also accepts an <code>airway(state)</code>{" "}
                  callback for physical telemetry.
                </dd>
              </div>
              <div>
                <dt>
                  <code>play(chunks, sampleRate, options?) → Playback</code>
                </dt>
                <dd>
                  Accepts synchronous or asynchronous chunks. Supports an AudioContext and AbortSignal. Use{" "}
                  <code>stop()</code> to interrupt and <code>done</code> to await completion.
                </dd>
              </div>
              <div>
                <dt>
                  <code>voice.free()</code>
                </dt>
                <dd>
                  Releases the engine. Stop and finish playback before freeing a voice that is still
                  streaming.
                </dd>
              </div>
            </dl>
            <h3>Bundled resources</h3>
            <p>
              The package exports <code>intone/worker.js</code>, <code>intone/worklet-live.js</code>,{" "}
              <code>intone/intone_chimera.wasm</code>, <code>intone/intone_creatures.wasm</code> and{" "}
              <code>intone/cmudict.txt.gz</code>. They ship with the library; there is no synthesis service or
              API key.
            </p>
          </section>

          <section id="troubleshooting">
            <h2>Troubleshooting</h2>
            <h3>No sound after an await</h3>
            <p>
              Browsers require a user gesture. Call <code>play()</code> directly inside a click or tap, or
              call <code>unlockAudio(context)</code> at the start of that handler before awaiting work, then
              pass that context to playback.
            </p>
            <h3>WASM, dictionary or worker returns 404</h3>
            <p>
              Assets resolve next to the library with <code>new URL("./file", import.meta.url)</code>. Vite
              and Next.js copy them into the build. Bun's bundler does not: serve the files yourself and pass
              explicit <code>wasm</code> and <code>dictionary</code> URLs, plus a module <code>Worker</code>{" "}
              instance as <code>worker</code>. Set <code>dictionary: false</code> to use spelling rules alone,
              with reduced pronunciation accuracy. The live instrument additionally accepts a{" "}
              <code>worklet</code> URL.
            </p>
            <h3>Next.js says window or AudioContext is undefined</h3>
            <p>
              Create voices in a client-side effect or event handler. The documentation's module example
              assumes a browser entry point. Release voices in your component's cleanup.
            </p>
            <h3>A score rejects timing options</h3>
            <p>
              Songs and scores already specify pitch and timing. Use score transforms to edit them instead of
              passing <code>rate</code>, <code>f0</code> or <code>accent</code>. Chimera currently speaks
              English, sounds synthetic, and phone latency has not yet been measured.
            </p>
          </section>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

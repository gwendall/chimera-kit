"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Agent } from "@/components/Agent";
import { Anyone } from "@/components/Anyone";
import { Beasts } from "@/components/Beasts";
import { Consonants } from "@/components/Consonants";
import { Crowd } from "@/components/Crowd";
import { Director } from "@/components/Director";
import { Engines } from "@/components/Engines";
import { IllustratedIntro } from "@/components/IllustratedIntro";
import { Instrument } from "@/components/Instrument";
import { Layers } from "@/components/Layers";
import { Live } from "@/components/Live";
import { Sing } from "@/components/Sing";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { Speed } from "@/components/Speed";
import { useStudio } from "@/components/useStudio";
import { LINKS } from "@/lib/links";
import { studio } from "@/lib/studio";

const MORE: { name: string; render: () => ReactNode }[] = [
  { name: "Latency", render: () => <Speed /> },
  { name: "Crowds", render: () => <Crowd /> },
  { name: "Instrument", render: () => <Instrument /> },
  { name: "Consonants", render: () => <Consonants /> },
  { name: "Creatures", render: () => <Beasts /> },
];

function Facts() {
  const { firstSampleMs } = useStudio();
  return (
    <dl className="facts">
      <div>
        <dt>{firstSampleMs === null ? "~10 ms" : `${firstSampleMs.toFixed(1)} ms`}</dt>
        <dd>{firstSampleMs === null ? "to the first sound" : "to the first sound, measured just now"}</dd>
      </div>
      <div>
        <dt>274 KB</dt>
        <dd>the whole engine, gzipped</dd>
      </div>
      <div>
        <dt>0</dt>
        <dd>servers, accounts or models to download</dd>
      </div>
      <div>
        <dt>1 line</dt>
        <dd>to switch to a natural-sounding engine</dd>
      </div>
    </dl>
  );
}

function More() {
  const [open, setOpen] = useState(0);
  const shown = MORE[open] ?? MORE[0];
  return (
    <section id="more">
      <div className="intro">
        <span className="label">More from the same engine</span>
        <h2>{"Latency, crowds, an instrument, and animals."}</h2>
      </div>
      <fieldset className="tabs">
        <legend className="sr-only">Demo to show</legend>
        {MORE.map((item, i) => (
          <button
            key={item.name}
            type="button"
            className="chip"
            aria-pressed={open === i}
            onClick={() => setOpen(i)}
          >
            {item.name}
          </button>
        ))}
      </fieldset>
      <div className="more">{shown?.render()}</div>
    </section>
  );
}

function Numbers() {
  return (
    <section id="numbers">
      <div className="intro">
        <span className="label">Numbers and limits</span>
        <h2>{"What it costs, and what it does not do."}</h2>
      </div>
      <div className="two">
        <table className="facts-table">
          <tbody>
            <tr>
              <th>Engine</th>
              <td>274 KB gzipped, WebAssembly</td>
            </tr>
            <tr>
              <th>JavaScript to speak</th>
              <td>2.0 KB gzipped</td>
            </tr>
            <tr>
              <th>Pronouncing dictionary</th>
              <td>869 KB, optional</td>
            </tr>
            <tr>
              <th>First sound</th>
              <td>about 10 ms after the call, on an Apple M2</td>
            </tr>
            <tr>
              <th>Processor</th>
              <td>about a third of one core per voice speaking</td>
            </tr>
            <tr>
              <th>Network</th>
              <td>none after the engine loads</td>
            </tr>
            <tr>
              <th>Output</th>
              <td>the same text and options always give the same samples</td>
            </tr>
          </tbody>
        </table>
        <ul className="plain-list">
          <li>
            It sounds synthetic. Every sound is computed from a simulated throat, not copied from a recording.
          </li>
          <li>It speaks English only, for now.</li>
          <li>It does not clone a person's voice. A body describes a kind of voice.</li>
          <li>Timings on phones have not been measured yet.</li>
          <li>It is a private preview: not on npm yet, and the API will change.</li>
        </ul>
      </div>
    </section>
  );
}

export default function Page() {
  useEffect(() => {
    // The engine and its dictionary (about 1.1 MB) wait for the page's own fonts and scripts: on a
    // slow phone they would otherwise share the line with the first paint. A tap loads them at once.
    const idle =
      window.requestIdleCallback ??
      ((run: () => void, _options?: IdleRequestOptions) => window.setTimeout(run, 200));
    idle(() => void studio.load(), { timeout: 1500 });
    // pointerdown doesn't count as a gesture on iOS: these do. A scroll's touchend is refused, so keep trying.
    const events = ["pointerup", "touchend", "click", "keydown"];
    const wake = () => {
      void studio.load();
      if (!studio.unlock()) return;
      for (const name of events) document.removeEventListener(name, wake, true);
    };
    for (const name of events) document.addEventListener(name, wake, true);
    return () => {
      for (const name of events) document.removeEventListener(name, wake, true);
    };
  }, []);

  return (
    <>
      <SiteHeader />
      <main className="wrap" id="main">
        <div className="hero" id="direct">
          <IllustratedIntro scene="direct">
            <span className="label">A JavaScript library for controllable speech</span>
            <h1>Text to speech you can direct, word by word.</h1>
            <p className="lead">
              Add speech to your app with a few lines of JavaScript. Choose the voice, shape each word, or
              speak a language model's answer as it arrives. Everything runs in the browser.
            </p>
            <div className="row">
              <Link href={LINKS.start} className="go" style={{ textDecoration: "none" }}>
                Get started
              </Link>
              <Link href={LINKS.docs}>Read the documentation</Link>
            </div>
          </IllustratedIntro>
          <Facts />
        </div>
        <Director />
        <Live />
        <Anyone />
        <Sing />
        <Agent />
        <Engines />
        <Layers />
        <More />
        <Numbers />
      </main>
      <SiteFooter />
    </>
  );
}

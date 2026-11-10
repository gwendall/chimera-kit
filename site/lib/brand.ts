// Vercel sets this at build time to the project's production domain, so the canonical origin
// follows the domain when the name changes. VERCEL_URL would point crawlers at a preview.
const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const BRAND = {
  name: "intone",
  origin: production ? `https://${production}` : "http://localhost:3000",
  title: "intone: text to speech you can direct, word by word",
  description:
    "A JavaScript text to speech library that runs in the browser. Choose the stressed words, move the pitch, set the mood and the voice. First sound in about 10 ms, 274 KB, no server.",
  keywords: [
    "text to speech",
    "speech synthesis",
    "low latency",
    "physical modeling",
    "CHIMERA",
    "WebAssembly",
    "singing synthesis",
    "browser TTS",
  ],
  // The page's light tokens (app/globals.css), for the share card and the icons.
  paper: "#ffffff",
  ink: "#111110",
  muted: "#6f6b65",
  line: "#d4d0c9",
  accent: "#e5461b",
  accentFill: "#c13a13",
  onAccent: "#ffffff",
} as const;

// Vercel sets this at build time to the project's production domain, so the canonical origin
// follows the domain when the name changes. VERCEL_URL would point crawlers at a preview.
const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const BRAND = {
  name: "intone",
  origin: production ? `https://${production}` : "http://localhost:3000",
  title: "intone: a voice you can direct",
  description:
    "Speech that runs in the page, starts in milliseconds and does what your code says, down to the syllable. Powered by CHIMERA.",
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
  background: "#0c0a09",
  ink: "#f4efe8",
  heat: "#ff5c36",
} as const;

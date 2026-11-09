// Vercel sets this at build time to the project's production domain, so the canonical origin
// follows the domain when the name changes. VERCEL_URL would point crawlers at a preview.
const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const BRAND = {
  name: "intone",
  origin: production ? `https://${production}` : "http://localhost:3000",
  title: "intone: a voice with a throat",
  description:
    "Text to speech that simulates a human airway in your browser. No model weights, no server, first sound in milliseconds.",
  keywords: [
    "text to speech",
    "speech synthesis",
    "physical modeling",
    "vocal tract",
    "WebAssembly",
    "singing synthesis",
    "browser TTS",
  ],
  background: "#0c0a09",
  ink: "#f4efe8",
  heat: "#ff5c36",
} as const;

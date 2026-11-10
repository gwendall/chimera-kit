// Canonical public origin. Keep package metadata and README links in sync when it changes.
export const BRAND = {
  name: "Chimera Kit",
  origin: "https://chimerakit.dev",
  title: "Chimera Kit: the JavaScript toolkit for Chimera",
  description:
    "Put Chimera in your app. Physical voice synthesis, singing, a live instrument, beatbox and creatures, with a small JavaScript API. Runs in the browser.",
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

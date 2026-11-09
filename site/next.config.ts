import type { NextConfig } from "next";

// Everything runs in the visitor's browser, so the site is plain static files.
const config: NextConfig = { output: "export", images: { unoptimized: true }, devIndicators: false };

export default config;

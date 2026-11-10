import type { NextConfig } from "next";

// Everything runs in the visitor's browser, so the site is plain static files.
// One page, mostly first visits: its few KB of CSS go inline instead of a render-blocking request.
const config: NextConfig = {
  images: { unoptimized: true },
  devIndicators: false,
  experimental: { inlineCss: true },
};

export default config;

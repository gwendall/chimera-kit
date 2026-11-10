import type { NextConfig } from "next";

// Everything runs in the visitor's browser, so the site is plain static files.
// One page, mostly first visits: its few KB of CSS go inline instead of a render-blocking request.
const config: NextConfig = {
  images: { unoptimized: true },
  devIndicators: false,
  experimental: { inlineCss: true },
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      // The file: loader is Node-only. Browsers fetch the WASM and dictionary over HTTP.
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:fs\/promises$/ }));
    }
    return config;
  },
};

export default config;

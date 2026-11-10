// Deploy this release only after its npm version and integrity are verified.
export const RELEASE = { name: "chimera-kit", npmVersion: "0.1.0" as string | null };
export const LINKS = {
  home: "/",
  docs: "/docs",
  start: "/docs#get-started",
  examples: "/#direct",
  npm: `https://www.npmjs.com/package/${RELEASE.name}`,
  source: "https://github.com/gwendall/chimera-kit",
  issues: "https://github.com/gwendall/chimera-kit/issues",
  engine: "https://github.com/jamesondh/chimera-vocal-synth",
  author: "https://github.com/jamesondh",
} as const;

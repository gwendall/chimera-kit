// Activate the npm link after the first successful public release.
export const RELEASE = { name: "chimera-kit", npmVersion: null as string | null };
export const LINKS = {
  home: "/",
  docs: "/docs",
  start: "/docs#get-started",
  examples: "/#direct",
  npm: `https://www.npmjs.com/package/${RELEASE.name}`,
  engine: "https://github.com/jamesondh/chimera-vocal-synth",
  author: "https://github.com/jamesondh",
} as const;

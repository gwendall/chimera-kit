<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Site checks

- Keep vertical spacing on the chrome component. `.wrap` owns the page's horizontal gutter;
  do not let its padding reset the footer's top and bottom spacing.
- After chrome or documentation navigation changes, run `bun scripts/site-layout-check.ts <url>`
  from the repository root against a machine-managed server or the deployed site.
- Activate npm links through `lib/links.ts` only after verifying the published version. The source
  repository is private; public navigation must not send visitors to inaccessible source pages.

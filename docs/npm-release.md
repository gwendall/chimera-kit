# First npm release

The package remains private and unpublished. The website uses `site/lib/links.ts` as its release
switch: no active npm link appears until `RELEASE.npmVersion` has a verified published version.
Package homepage and help links point to the public documentation, not the private source repo.

When the first release is authorized:

1. Choose a version and remove `private: true` in `package.json`. The current `0.0.0` is a placeholder.
2. Qualify that exact source through CI. Build the release artifacts in a clean checkout with
   `bun install --frozen-lockfile` and `bun run build`.
3. Inspect `npm pack --dry-run --json`. Every target in `exports` must exist. The package must include
   both WASM engines, the dictionary, worker, worklet, TypeScript declarations, README, license and
   third-party notices. No environment files, source recordings or private assets belong in it.
4. Install the resulting tarball into a clean consumer app and smoke-test speech, worker playback,
   singing, resource URLs and imports. A successful site build alone does not qualify a package.
5. Confirm registry ownership and publish the reviewed artifact with npm authentication outside
   the repository. Never paste credentials into source or logs.
6. Verify the public package and install command. Then set `RELEASE.npmVersion`, update the preview
   status in the README and homepage, and deploy the site. The header and footer will expose npm.

The repository metadata is accurate, but source access remains private until separately authorized.
Do not add a public source CTA while the repo is private. Update canonical origin and package URLs
together when a custom domain replaces the current production domain.

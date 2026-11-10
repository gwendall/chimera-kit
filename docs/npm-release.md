# npm releases

The source is public at `https://github.com/gwendall/chimera-kit`. The package is prepared as
`chimera-kit@0.1.0`. Publication is a separate authenticated action. Public links use
`https://chimerakit.dev`. The release branch prepares `RELEASE.npmVersion` in `site/lib/links.ts`;
do not merge or deploy that branch until the registry version and integrity are verified.

For each authorized release:

1. Set the version in `package.json` and `RELEASE.npmVersion` on a release branch. Keep the
   documentation website's own package private. The production site keeps its previous release
   until publication succeeds.
2. Qualify that exact source through CI. The pipeline builds in a clean checkout, runs the existing
   checks, then uploads `npm-package-<commit>` with the tarball and its `npm-pack.json` manifest.
   Download the artifact from the successful run for the release commit.
3. Inspect the manifest and tarball. Every target in `exports` must exist. The package must include
   both WASM engines, the dictionary, worker, worklet, TypeScript declarations, README, license and
   third-party notices. No environment files, source recordings or private assets belong in it.
4. Install the resulting tarball into a clean consumer app and smoke-test speech, worker playback,
   singing, resource URLs and imports. A successful site build alone does not qualify a package.
5. Confirm registry ownership and run `npm publish <reviewed-tarball> --access public`, with npm
   authentication outside the repository. Never paste credentials into source or logs. Do not
   rebuild between inspection and publication.
6. Verify the registry version and integrity against the manifest, then install that registry
   version in a clean consumer and repeat the smoke check. Merge the qualified release branch
   and deploy. The header, footer and documentation then expose the verified npm version.
7. Tag the release source and publish GitHub release notes linking npm, the site and documentation.

The npm `repository` field points to the public GitHub repository, `homepage` to the site, and
`bugs` to GitHub Issues. The README links all three services and the documentation; the site's
footer and documentation link back to the source. Keep these links and canonical origin in sync.

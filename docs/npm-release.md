# npm releases

The package is prepared as `chimera-kit@0.1.0`. Publication is a separate authenticated action.
The website uses `site/lib/links.ts` as its release switch: no active npm link appears until
`RELEASE.npmVersion` has a verified published version. Public links use `https://chimerakit.dev`.

For each authorized release:

1. Set the version in `package.json`. Keep the documentation website's own package private.
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
   version in a clean consumer and repeat the smoke check. Set `RELEASE.npmVersion`, update the
   preview status on the homepage, and deploy. The header and footer will then expose npm.

The source repository stays private until separately authorized. The optional npm `repository`
field is omitted to avoid an inaccessible public link. Homepage and help links point to the public
documentation. Do not add a public source CTA while the repo is private. Keep canonical origin,
package URLs and README links in sync.

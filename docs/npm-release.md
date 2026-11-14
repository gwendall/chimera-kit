# Qualified release archives and npm

The source and MIT package remain public at `https://github.com/gwendall/chimera-kit`.
Version 0.2.0 is prepared in `package.json`; a version bump does not publish a release. A qualified
GitHub tarball is a distribution option when npm authentication is unavailable. Never ask for or
store registry credentials in this repository.

## Prepare and qualify

1. Put the package version, changelog and API documentation on a small release branch. Do not
   update `site/lib/links.ts` to advertise a registry version that has not been verified on npm.
2. Merge only after the release PR's normal CI checks pass. The main-branch pipeline must then
   qualify the exact merged source commit. Do not reuse an unrelated branch's `dist/` or tag an
   unqualified source. No extra local build is needed when CI already built that source.
3. The existing CI workflow builds the package and runs types, lint, Rust/JS tests, size budgets,
   browser checks and smoke scenarios. Its final step packs with `npm pack --ignore-scripts` and
   uploads `npm-package-<github.sha>`, containing `chimera-kit-0.2.0.tgz` and `npm-pack.json`.
   A pull-request run's artifact can describe its synthetic merge SHA; final release provenance
   must use the successful main push run and its exact commit.
4. Download that artifact into a new staging directory. Check the run's event, conclusion and
   `headSha`, and retain its URL with the release evidence. For example, after qualification:

   ```sh
   gh run view RUN_ID --repo gwendall/chimera-kit --json event,conclusion,headSha,url
   gh run download RUN_ID --repo gwendall/chimera-kit \
     --name npm-package-QUALIFIED_MAIN_SHA --dir RELEASE_STAGING_DIRECTORY
   ```

5. Verify the manifest's name/version, tarball SHA1 and SHA512 integrity, and every listed file's
   size. Inspect `tar -tzf` and confirm every `package.json.exports` target exists. The allowlist
   ships generic `dist/`, documentation and third-party notices; npm also includes package metadata,
   README and license. Required runtime assets include both wasm engines, dictionary, Worker and
   worklet entries, declarations and all imported JS chunks. Reject environment files, credentials,
   recordings, copyrighted/private text, prepared song plans, states, telemetry and show assets.
6. Record SHA256 for the tarball and each wasm binary extracted from that same tarball, plus the
   source commit, Actions run and `npm-pack.json`. Verify any consumer's prepared checkpoint engine
   identity against these exact wasm bytes. Rebuilding equivalent source can produce a different
   module digest and does not qualify an existing state archive. Do not rebuild after inspection.
7. Install the reviewed tarball in a clean consumer and smoke-test public imports, speech, singing,
   Worker/worklet resource URLs, prepared performance, sequence playback and seek. Do not publish
   merely because a documentation site builds. Record checks against the tarball's integrity.

## Publish a GitHub artifact only after qualification

Publication is a separate outward-facing step. Do not run it while preparing this branch. After
main is qualified and the publication step is authorized, tag that exact source as `v0.2.0` and
attach the reviewed tarball, `npm-pack.json` and a `SHA256SUMS` file to the public GitHub Release.
Use the tarball from CI unchanged; do not pack a mutable local checkout. Release notes should link
the changelog, API documentation, qualification run and source commit, and state whether npm is
available. A GitHub Actions artifact alone is not a permanent public download URL.

Consumers can then pin the public asset, independently of registry authentication:

```sh
npm install --save-exact https://github.com/gwendall/chimera-kit/releases/download/v0.2.0/chimera-kit-0.2.0.tgz
```

Keep the resulting lockfile and its SHA512 integrity. This command is usable only once that release
asset exists. A GitHub release archive is the package tarball, not GitHub's automatic source archive:
the latter does not contain the qualified `dist/` build.

## Optional npm publication

When registry authentication is available and publication is authorized, publish the same reviewed
archive with `npm publish chimera-kit-0.2.0.tgz --access public`. Verify registry version and integrity
against `npm-pack.json`, install that version in a clean consumer, and repeat the resource/import
smoke check. Only then update `RELEASE.npmVersion` in `site/lib/links.ts` and deploy the documentation
site's registry links. The website's own package stays private. GitHub distribution does not imply
npm publication or require changing the Kit repository's public MIT status.

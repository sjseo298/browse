# Releasing browse

One version ships an extension zip, the npm package `@sjseo298/browse` (`opencode-browse-<version>.tgz`: a Node
launcher, for `npx` and `npm install -g`) and the `browse` binaries. The npm package carries no extension.

The CLI, relay and MCP server are the Rust `browse` binary (crate `rust/crates/browse`, workspace `rust/`; the
TypeScript CLI in `cli/` is kept as the reference and isn't built or released anymore). `@sjseo298/browse` holds only
`dist/cli.mjs` ([rust/npm/browse.mjs](rust/npm/browse.mjs)), which runs the binary of the optional dependency npm
installed for the machine, `@sjseo298/browse-<target>`; `dist/cli.mjs` stays the bin path because agent configs written
by the TypeScript CLI run `node .../dist/cli.mjs mcp`. The version is baked into the binary at build time
(`BROWSE_VERSION`, with the run's `BROWSE_BUILD_ID`), and `rust/Cargo.toml`/`Cargo.lock` carry it too
(`scripts/version.ts`). Each binary is published two ways:
as an npm package `@sjseo298/browse-<target>` holding `bin/browse` (`bin/browse.exe` on Windows) and a package.json with
`os`, `cpu` and, on Linux, `libc`; and as one target per binary on the release service, which the [install
script](install) downloads. The [release service](#the-release-service) file is
`opencode-browse-<target>-<version>.tgz`; it carries the same verified bytes as the npm package. Targets:
`linux-x64`, `linux-x64-baseline`, `linux-arm64`, `linux-x64-musl`, `linux-x64-baseline-musl`, `linux-arm64-musl`,
`darwin-arm64`, `darwin-x64`, `darwin-x64-baseline`, `windows-x64`, `windows-x64-baseline` (Windows on ARM64 runs x64).
The service names macOS `macos-*`. A `-baseline` target carries the same binary as its base target (Rust's x86-64
target doesn't use AVX2), and `@sjseo298/browse` depends only on the seven base targets. Locally:
`cd rust && BROWSE_VERSION=<version> script/release.sh linux-x64 linux-x64-musl`, then
`bun scripts/npm-package.ts platforms --binaries rust/dist --out <dir>` (with `--target <name>` for only some) and
`bun scripts/npm-package.ts main --out <dir>`.

In this fork (`sjseo298/browse`), **releases are built and published 100% locally** via
[scripts/dist.ts](scripts/dist.ts) — do **not** run upstream's `.github/workflows/release.yml` (which targets
Anomaly's OIDC release service, AWS secrets, npm trusted publishing, and Chrome Web Store). Work lands on `dev`.

## Cutting a fork release (aligned with upstream + local build + retention of 2 releases)

**Version rule:** Keep versions aligned with `upstream` (`anomalyco/browse`). Do **not** bump `0.1.x` for fork-only
fixes — commit the fix to `dev` and use `bun scripts/dist.ts all --overwrite` on the current version instead. Only bump
the version when aligning with a new upstream release (or when explicitly needed for auto-update).

See [AGENTS.md §3a](AGENTS.md#3a-publishing-fork-distributions-agent-playbook) for the full agent playbook. Summary:

1. **Bump version & write changelog:** `bun scripts/version.ts set <version>` (updates `cli/package.json`, `package.json`,
   `public/manifest.json`, `rust/Cargo.toml`, `rust/Cargo.lock`) and create `changelog/<version>.md`.
2. **Run checks:** `bun run typecheck`, `bun test ./test`, `(cd rust && cargo test --workspace --locked -- --test-threads=1)`,
   and the rebrand audit (`AGENTS.md §5`).
3. **Commit, tag, and push:** `git commit -m "release: v<version>" && git tag v<version> && git push origin dev v<version>`.
4. **Build, validate, publish, and prune:** `bun scripts/dist.ts all`
   - Compiles macOS targets (`darwin-arm64`, `darwin-x64`, `darwin-x64-baseline`), builds the unpacked extension zip
     (preserving `manifest.key`), validates `decide()`, uploads assets to GitHub Release `v<version>`, updates `gh-pages`,
     and **automatically prunes older GitHub Releases and `release/dist-*` folders so only the latest 2 distributions
     remain** (the newest release and the immediately previous one; standalone via `bun scripts/dist.ts prune --keep 2`).
5. **Overwriting the latest release (`--overwrite`):** If a quick fix should replace the current latest release without
   bumping the version, commit the fix to `dev` and run `bun scripts/dist.ts all --overwrite` (force-moves tag `v<version>`
   to `HEAD`, updates release notes, replaces assets, and bumps `sequence` on `gh-pages`). Note that existing relays
   already running that exact version string treat `candidate == running.version` as `up_to_date`
   (`rust/crates/browse/src/update.rs:253` passes `sha256: None`), while fresh `curl | bash` installs get the new binary;
   bump a patch version whenever existing relays must auto-update.

*(The upstream GitHub Actions release pipeline `.github/workflows/release.yml` and `.github/release/*.sh` remain in the
repository only for upstream merge compatibility and are not executed in this fork.)*

## The security boundary

Every job that holds a secret, an OIDC token or a write token (tag, attest, every publish job) runs only code in
`.github/`: the workflow file and the shell scripts in [.github/release/](.github/release/), checked out with a sparse
checkout of `/.github/release/`. Those jobs treat the build artifacts as data: each artifact must match the SHA256SUMS
digest its job reported and, before publishing, its GitHub attestation from this workflow on `dev`. They never run
repository code, `bun install` or package lifecycle scripts. Only `build` runs repository code, and it has no
environment, secrets or id-token. The tag job checks out the repository but runs only `tag-release.sh` (git and jq,
hooks off).

So `.github/` is what to protect: [.github/CODEOWNERS](.github/CODEOWNERS) makes Dax and Ryan its owners, and the
rulesets below require their review. The jobs that need a secret run in the environment `release`, which admits only
`dev`, and fetch it from AWS Secrets Manager ([Secrets](#secrets)).

## How a dev install gets its extension

The dev zip keeps the manifest `key`, so it loads with the same unpacked ID as a checkout's `dist/`, which the relay
trusts, and every dev build still publishes it to the release service
(`https://sjseo298.github.io/browse/release/browse/extension/dev/chromium`). The Rust CLI doesn't fetch it: `browse install` points at
the Chrome Web Store item on every channel, and the store build works with dev CLIs (the relay keeps accepting older
extension protocols). To try a dev extension, download the zip, unpack it and load it unpacked, then `browse pair`;
`browse extension` prints these steps on the dev channel and the README's Updates section has them. (The TypeScript CLI baked the dev zip's sha256 in and unpacked it into
`<cache root>/extension`; that is gone with it.) Dev builds never go to the Chrome Web Store: every upload is
reviewed, too slow for a build per push.

## The release service (fork distribution)

`https://sjseo298.github.io/browse/release` is this fork's release service, hosted statically on the **`gh-pages` branch**
of `sjseo298/browse` (GitHub Pages source `gh-pages` at `/`; `/release/` is gitignored on `dev`, so manifests live on
`gh-pages` without polluting `dev`). It speaks the client release protocol of
[anomalyco/release](https://github.com/anomalyco/release) (spec: its `docs/protocol.md`).

**100% local build, GitHub only as publish target (no GitHub Actions):**

- **Builder & publisher:** [scripts/dist.ts](scripts/dist.ts) (`build`, `validate`, `publish`, `all`), run on the maintainer's
  machine using the local Rust toolchain (`1.99.1`, pinned in `.github/workflows/ci.yml`) and `gh` CLI (no CI runners,
  no AWS/OIDC secrets, no Chrome Web Store upload).
- **Host targets:** on Apple Silicon macOS, `build` compiles `darwin-arm64` (native) and `darwin-x64` (`rustup target add x86_64-apple-darwin`),
  and packs `macos-arm64`, `macos-x64`, and `macos-x64-baseline` (`opencode-browse-darwin-<arch>-<version>.tgz`, layout
  `package/bin/browse` + `package.json` + `LICENSE`) plus the **unpacked** extension zip `browse-extension-<version>.zip`
  (keeping `manifest.key` so unpacked Chrome installs receive the trusted extension ID). `linux-x64` / `windows-x64` are
  omitted unless cross-built locally (e.g. Docker/zig or a native host) and passed via `--target`.
- **Where artifacts live:** tarballs and the extension zip are uploaded to **GitHub Releases** (`v<version>`), and
  `gh-pages` serves:
  - `release/browse/cli/<channel>.json` (`schema: 1`, `app: "browse"`, `artifact: "cli"`, `rollout_percent: 100`,
    `distributions: [{ kind: "direct" }]`, and flat `targets.<target>` entries with absolute `https://` GitHub Release URLs,
    `size`, and `sha256`; `release.version` appears first in `release` for the shell installer parser)
  - `install` and `install.ps1` (patched in the fork to accept both absolute `https://` URLs and relative `/...` paths)
- **Local release workflow:**
  1. `bun scripts/version.ts set <version>` + update `changelog/<version>.md`, commit and push to `origin/dev`, then
     `git tag v<version> && git push origin v<version>`.
  2. `bun scripts/dist.ts all --version <version>` — builds tarballs + extension zip, validates the generated manifest
     with `decide()` (`cli/src/update/release-service.ts`), creates/updates GitHub Release `v<version>`, pushes
     `gh-pages` (incrementing `sequence` idempotently), and enables GitHub Pages via `gh api` if not yet active.

Every running fork relay still checks `https://sjseo298.github.io/browse/release/browse/cli/<channel>.json` at launch
and hourly (`rust/crates/browse/src/update.rs`, `file_url()` accepts `https://` directly), verifying size and SHA-256
before replacing the binary in place.

*(Below are upstream's reference notes for the original multi-OS release service layout and conventions.)*

| Artifact | Target | File | Latest link |
| --- | --- | --- | --- |
| `extension` | `chromium` | `browse-extension-<version>.zip` (the store build on stable, unpacked on dev); `opencode-browser-<version>.zip` on releases before the rename | https://sjseo298.github.io/browse/release/browse/extension/stable/chromium |
| `cli` | `linux-x64`, `linux-x64-baseline`, `linux-arm64`, `linux-x64-musl`, `linux-x64-baseline-musl`, `linux-arm64-musl` | `opencode-browse-<target>-<version>.tgz` | https://sjseo298.github.io/browse/release/browse/cli/stable/linux-x64 |
| `cli` | `macos-arm64`, `macos-x64`, `macos-x64-baseline` (files say `darwin-*`) | `opencode-browse-darwin-<arch>-<version>.tgz` | https://sjseo298.github.io/browse/release/browse/cli/stable/macos-arm64 |
| `cli` | `windows-x64`, `windows-x64-baseline` | `opencode-browse-windows-<arch>-<version>.tgz` | https://sjseo298.github.io/browse/release/browse/cli/stable/windows-x64 |

Every target has a `.../<target>/info` with its version, size and SHA-256. `install` reads the manifest, checks the
file's size and SHA-256 and installs it; every relay (except a checkout build) polls `cli/<stable|dev>.json` at launch
and hourly, even with updates off, with User-Agent `browse/<channel>/<version>/cli/<kind>` (`binary`, `npm`, `bun`,
`pnpm`, `yarn`, `volta`, `npx`, `bunx`, `pnpm-dlx`, `yarn-dlx`, `other` for an install browse didn't make, which only checks), which the protocol allows after its artifact segment
and lets analytics split installs by kind. A binary install downloads the manifest's file; a global install runs its
package manager for `@sjseo298/browse@<the manifest's version>`, and retries quietly while npm doesn't have that version
yet. `--version` stays on npm because the protocol has one current release per channel and no version lookup.

A TypeScript binary install's updater (0.0.17 and earlier) runs the install script baked into the binary it is running,
so those releases keep reading future channel manifests with their own installer: the cli tarballs keep the layout
`package/bin/browse[.exe]`. The Rust binary's updater ([rust/crates/browse/src/update.rs](rust/crates/browse/src/update.rs))
reads the manifest itself and unpacks the same tarball. When a TypeScript relay has installed the Rust binary it runs
`browse runtime-switch <version>`, and the Rust CLI stops any TypeScript relay it finds (POST /shutdown), so the Rust
relay takes over ([rust/crates/browse/src/legacy.rs](rust/crates/browse/src/legacy.rs)). Manifest changes must stay readable by
older installers: relative `url`s, flat target objects, and `release.version` before any other `version` key.

## One-time setup

1. **Default branch** `dev` (Settings → General).
2. **Release service.** The fork's service (see below) serves static manifests and must accept this repository's
   publishes: workflow `.github/workflows/release.yml` on `refs/heads/dev` in environment `release`, artifacts `cli`
   and `extension`, channels `stable`, `beta` and `dev`. If the service enforces a publisher registry, register
   [scripts/release-registry.json](scripts/release-registry.json) there as `registry/browse.json` **before the next
   stable release**: until then the service refuses the stable channel, and the installer has no stable manifest to
   read.
3. **Chrome Web Store (not used in this fork).** The fork's extension is loaded **unpacked** from `dist/`
   (AGENTS.md §3); sjseo298 has no CWS item, no `store/` assets and no `scripts/cws-auth.ts`. If a sjseo298 CWS
   item is ever created, follow the upstream RELEASING.md (anomalyco/browse) for the full procedure: publisher
   dashboard item, CWS API in a Google Cloud project, OAuth desktop client, refresh token.
5. **Environment `release`** (Settings → Environments): *Deployment branches and tags* → *Selected* → branch `dev`
   only. No required reviewers: who may release is decided by `plan`'s admin/maintain check and the rulesets. It holds
   no secrets: it is the environment claim the AWS role's trust requires ([Secrets](#secrets)). Delete the old `npm`,
   `chrome-web-store`, `release-dev`, `npm-dev` and `chrome-web-store-dev` environments.
6. **Release deploy key.** `ssh-keygen -t ed25519 -N "" -C "browse release tags" -f release-tag-key`; add
   `release-tag-key.pub` under Settings → Deploy keys with write access, store the private key as
   `browse/release/RELEASE_TAG_KEY` (`bun set browse release RELEASE_TAG_KEY < release-tag-key`), and delete both files.
7. **Rulesets** (Settings → Rules):
   - branch `dev`: require a pull request with code owner review, block force pushes and deletion; bypass:
     *Repository admin* and *Deploy keys* (the release commit comes back to dev with the deploy key).
   - tags `v*`: restrict creation, updates and deletion; bypass: *Repository admin* and *Deploy keys* (the tag job).
8. **Actions** (Settings → Actions → General): require actions pinned to a full-length commit SHA.
9. **npm.** Every package publishes with trusted publishing: `@sjseo298/browse` and each `@sjseo298/browse-<target>`
   trust GitHub Actions in `sjseo298/browse`, workflow `release.yml`. There is no npm token anywhere.

   The eleven platform packages are set up already (November 2026): trusted publishing can only be configured on a
   package that exists, so each `@sjseo298/browse-<target>` was published once by hand as an empty `0.0.0` on the
   `placeholder` tag, then trusted like `@sjseo298/browse`, with no environment restriction. A new target needs the same:

   ```sh
   npm publish --access public --tag placeholder   # in a folder with just package.json (name, version 0.0.0) and a README
   npm trust github "@sjseo298/browse-<target>" --file release.yml --repository sjseo298/browse --allow-publish -y
   ```

   `npm trust list @sjseo298/browse-<target>` checks one.
10. **macOS signing (optional).** Without it the macOS binaries carry the ad-hoc signature the Rust linker gives
    them, which runs fine from the install script and npm (neither sets quarantine). To sign with a Developer ID:
    the certificate is `shared/APPLE_SIGNING_CERTIFICATE` in AWS (a Developer ID Application certificate exported
    without a password, base64 encoded, shared with every sjseo298 app); then `gh variable set MACOS_SIGNING --body true`
    and the sign-macos job runs, with publish-npm taking the macOS packages only from it.
11. **Windows signing (optional).** Without it `browse.exe` is unsigned and Windows Smart App Control blocks it, so
    install fails there. To sign with Azure Trusted Signing (now Artifact Signing): a signing account and certificate
    profile; an Azure identity with the **Artifact Signing Certificate Profile Signer** role (formerly Trusted Signing
    Certificate Profile Signer) on the account or profile and read access to the subscription; and a federated
    credential on that identity for this repository's `release` environment (issuer
    `https://token.actions.githubusercontent.com`, subject `repo:sjseo298/browse:environment:release`, audience
    `api://AzureADTokenExchange`). Then the six repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
    `AZURE_SUBSCRIPTION_ID`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` and
    `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`, and `gh variable set WINDOWS_SIGNING --body true`: the sign-windows
    job signs every `browse.exe` in the Windows tarballs over OIDC (no secret), checks each signature and repacks them,
    and publish-npm and the release service take the Windows packages only from it. macOS and Windows signing are
    independent; either, both or neither can be on.

## Secrets

Release secrets live in sjseo298's own secret store — the fork has **no access** to Anomaly's AWS account. The
upstream mechanism (a `secrets` repo managing AWS Secrets Manager, a `release`-environment OIDC role that a job
assumes with its GitHub token, `bun set browse release <NAME>` to set values) is reproduced under sjseo298's own
account and repo; the role name and the `browse/release/*` namespace below carry over unchanged. A local-only fork
needs no secrets at all (AGENTS.md §5). npm needs none (trusted publishing).

| Secret | Use |
| --- | --- |
| `browse/release/RELEASE_TAG_KEY` | the release deploy key: `tag` pushes `v<version>`, `push-release-to-dev` pushes the release commit |
| `browse/release/CWS_CLIENT_SECRET`, `browse/release/CWS_REFRESH_TOKEN`, var `CWS_CLIENT_ID` | the Chrome Web Store API (`publish-cws`) |
| `shared/APPLE_SIGNING_CERTIFICATE` | `sign-macos`, when the repository variable `MACOS_SIGNING` is true |

The Chrome Web Store ids are repository variables, not secrets: `CWS_CLIENT_ID`, `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`, as
are the signing switches (`MACOS_SIGNING`, `WINDOWS_SIGNING`) and the Azure ids the Windows signer logs in with.

## Undoing a bad release

- **npm.** npm users move forward, so release a fixed patch. `npm deprecate @sjseo298/browse@<bad> "<why>"`
  warns new installs; a user can rerun the installer with `--version <good>` (which installs from npm) to go back.
- **Chrome Web Store.** Roll back in the dashboard ([how](https://developer.chrome.com/docs/webstore/rollback)), or
  cancel a pending review.
- **Release service.** Binary installs follow the channel's current release: `promote` an earlier release with
  `client.sh action ... --action promote` (anomalyco/release docs/publishing.md), or publish a fixed patch. Because
  versions are never ordered, promoting the earlier one is a rollback even though its version is lower.

## Compatibility between the extension and the CLI

The store extension and the CLI update independently, so either can be ahead for an hour or so; a dev install's
extension moves with its CLI. The relay accepts extension protocols from `minExtensionProtocolVersion` to
`extensionProtocolVersion` (`cli/src/protocol.ts`). Bump `extensionProtocolVersion` only for a change an older relay
can't handle, and raise the minimum only when dropping older extensions. When they don't match, the status page,
`status` and tool errors name the side that's behind.

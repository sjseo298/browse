# AGENTS.md — Maintaining this fork (sjseo298/browse)

Read this first. It is the guide for AI agents (and humans) working in this repository.

## 1. What this repository is

A fork of [anomalyco/browse](https://github.com/anomalyco/browse) — **browse**: a native MCP
server + Chromium MV3 extension that lets AI agents use the user's **real browser** (real tabs,
logins, extensions). Agents open background tabs, read pages, click, type, screenshot, capture
network traffic, record the screen, and hand a tab back to the user (login/2FA/payment) via
**handoff**.

### Fork identity (non-negotiable)

- `origin` = `https://github.com/sjseo298/browse` — **this** repository.
- `upstream` = `https://github.com/anomalyco/browse` — the project we track. We **merge from it**; we do not adopt its identity.
- This fork must **not** brand itself as, point at, or follow Anomaly's infrastructure: no
  `anomalyco`, no `anoma.ly`, no `@opencode/browse` npm scope, no `opencode.ai` install URLs in
  user-facing paths. Everything user-facing points to **sjseo298**.
- The agent of record for this fork is the **sjseo298 opencode fork**
  (`https://github.com/sjseo298/opencode`), which carries its own improvements on top of
  upstream opencode. References to "OpenCode" as *the agent* should point at that fork, not at
  the upstream project.
- Upstream release secrets, Chrome Web Store account, and release-service tokens do **not** apply
  here. Never run the upstream `release` workflow as-is; see §5.

## 2. What browse provides (architecture)

| Component | Where | What it does |
| --- | --- | --- |
| **Chromium extension (MV3)** | `src/` + `public/manifest.json`, built to `dist/` by Vite | Service worker (`background.js`) + content script (`content.js`). Connects to the local relay over WebSocket with one-time pairing codes; drives Chrome tabs via `chrome.debugger` (CDP); agent tab groups; handoff notices; idle-tab cleanup; live settings sync; Solid.js pages (welcome/onboarding/settings). Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `webNavigation`, `scripting`, `notifications`, `<all_urls>`. |
| **`browse` binary (Rust)** | `rust/` (cargo workspace, 6 crates) | The released CLI + relay + MCP server. `browse-core` (shared contracts), `browse-relay` (WebSocket relay, pairing, CDP routing, HTTP API, tab registry, handoff), `browse-page` (page interaction over CDP: isolated worlds, Playwright in-page script for refs/aria snapshots, stealth), `browse-capture` (screenshots + diffs, network capture with secret redaction, console capture, screen recording MJPEG→MKV), `browse-script` (the `execute` tool: QuickJS sandbox with a Playwright-style `page` shim, only offered to clients without code mode), `browse` (the binary). |
| **TypeScript CLI** | `cli/` | The **reference implementation** of the protocol (spec for the Rust code). No longer built or released, but its tests still run. |
| **Release pipeline** | `scripts/`, `.github/`, `store/`, `install`, `install.ps1` | Channels `stable`/`beta`/`dev`; a release service serving manifests + tarballs; npm launcher package; Chrome Web Store item; GitHub Actions `release.yml` (dev/stable/check modes). Auto-update: every relay polls its channel manifest at launch and hourly, verifies size + SHA-256, swaps the binary in place. |

### MCP tools (27, current Rust implementation)

- **Page** (`browse-page`): `navigate`, `snapshot`, `click`, `fill`, `type`, `press`, `select`,
  `hover`, `drag`, `scroll`, `eval`, `wait_for`, `dialog`, `upload`, `emulate`, `webmcp`
- **Relay** (`browse-relay`): `tabs`, `handoff`, `demonstrate`, `status`, `settings`
- **Capture** (`browse-capture`): `screenshot`, `screenshot_diff`, `network`, `console`, `recording`
- **Script** (`browse-script`): `execute` (only for MCP clients without code mode; OpenCode gets
  the plain tools)

Tabs are the handle: `navigate`/`tabs` open a background agent tab and return its id; every page
tool takes `tab`. CLI: `browse serve`, `browse mcp` (stdio MCP proxy), `browse install` (writes
the MCP entry into 20+ agent configs), `browse pair`, `browse status`, `browse update`,
`browse extension`, `browse set hostname`, plus `browse <tool> --arg ...` for any tool.

Supported agent configs (excerpt): OpenCode (`~/.config/opencode/opencode.json`, JSONC
`mcp.servers`), Claude Code, Claude Desktop, Cursor, Codex, VS Code, Windsurf, Gemini CLI,
Goose, Grok, Cline, and more — full table in `rust/crates/browse/src/agents.rs`.

## 3. Local build & run (verified working)

Prereqs: **Bun** (the version pinned in `package.json` → `packageManager`), **Rust** (toolchain
pinned in `.github/workflows/ci.yml`, `RUST_TOOLCHAIN`) for the binary. Node is only needed if
you use the npm launcher; the binary runs standalone.

```sh
# 1) Extension (validated: `bun install --frozen-lockfile` → 330 packages; `bun run build` OK)
bun install --frozen-lockfile
bun run build                 # → dist/ : manifest.json, background.js, content.js, html, assets

# 2) Load it: chrome://extensions → developer mode → "Load unpacked" → select dist/
#    The manifest's `key` pins the same extension ID as the store build, which the relay trusts.

# 3) Relay/CLI binary
cd rust
cargo build --release         # → rust/target/release/browse
#    (full multi-target release build: BROWSE_VERSION=x script/release.sh <target>)

# 4) Pair + register with your agent
rust/target/release/browse pair          # prints the one-time code → enter it on the extension's status page
rust/target/release/browse install -a opencode   # writes the MCP entry into opencode.json
```

The MCP entry `browse install` writes for OpenCode is `mcp.servers.browse` with
`command: [<path-to-browse>, "mcp"]`. Manual equivalent:

```jsonc
// ~/.config/opencode/opencode.json
{ "mcp": { "servers": { "browse": { "type": "local", "command": ["browse", "mcp"], "enabled": true } } } }
```

Handy scripts: `bun run dev` (extension watch mode, dev builds), `bun run typecheck`,
`bun test ./test` (extension tests), `cd rust && cargo test` (Rust tests).
`bun run setup` does extension build + CLI install in one go (upstream's flow; after rebranding,
see §5 before running install-mode commands).

## 4. Upstream sync procedure (run after every merge)

1. **Merge, don't rebase-publish:**
   ```sh
   git fetch upstream
   git merge upstream/dev        # or rebase your fork commits onto upstream/dev
   ```
   Keep the fork's changes in a **small number of well-scoped commits** (e.g. one
   `fork: rebrand to sjseo298` commit, one per feature) so the fork patch stays easy to re-apply:
   `git diff upstream/dev...dev` must show only intended fork changes.
2. **Conflict policy:** upstream wins for *logic* (protocol, tools, relay); the fork wins for
   *branding* (URLs, names, docs, workflows, store). When a file contains both, take upstream's
   content and re-apply the rebranding (next step).
3. **Re-apply the rebranding** (§5) to every file it lists. After a merge, upstream has very
   likely re-introduced `anomalyco`/`anoma.ly`/`@opencode/browse`/`opencode.ai` references in
   exactly those files.
4. **Run the rebrand audit** (§5, last command). It must report nothing new.
5. **Run the tests:** `bun run typecheck && bun test ./test` and `cd rust && cargo test`.
6. **Do not** run the upstream release workflow, publish to Anomaly's release service, npm
   scope, or CWS item. The fork's release infra is sjseo298's (or absent, for local-only use).

## 5. Rebranding map (the fork patch — re-apply after every upstream merge)

Applied in the fork's first patch (commit `fork: rebrand to sjseo298`). Fork target values:

- `<FORK RELEASE SERVICE>` = `https://sjseo298.github.io/browse/release` (static hosting; must end in
  `/release` and speak the release protocol of `anomalyco/release`; overridable at runtime with
  `OPENCODE_BROWSER_RELEASE_SERVICE`)
- `<FORK INSTALL URL>` = `https://sjseo298.github.io/browse/install` / `install.ps1` (host the
  installer files in the same repo's GitHub Pages)

Already done in the first patch, besides the table below: deleted `store/` (CWS assets of the
upstream store item) and `scripts/cws-auth.ts` (upstream's CWS token tool); npm scope renamed
`@opencode/browse` → `@sjseo298/browse` repo-wide (including the npm scope flag in update
commands: `--@sjseo298:registry`); **dual-scope detection** added so the fork still recognizes
pre-fork upstream installs (line 17 below). Not touched on purpose (see §6): the wire
protocol identifiers (`opencode-browser-pairing-v3`, `opencode-browser.status`,
`opencode-browser-relay`) and the artifact tarball names (`opencode-browse-<target>-<version>.tgz`) —
renaming either breaks the extension/relay/store pairing contract or the release manifest naming.

| # | Location | Upstream value (replace) | Fork value | Notes |
| --- | --- | --- | --- | --- |
| 1 | `rust/crates/browse/src/update.rs:33` | `const RELEASE_SERVICE: &str = "https://anoma.ly/release";` | `"<FORK RELEASE SERVICE>"` | Single source of truth on the Rust side. `OPENCODE_BROWSER_RELEASE_SERVICE` env var overrides it (must end in `/release`) — usable for tests/local instead of editing. |
| 2 | `cli/src/paths.ts:270` | `export const RELEASE_SERVICE = "https://anoma.ly/release"` | same | Reference-impl constant; keep in sync with #1. |
| 3 | `rust/crates/browse/src/{protocol.rs,setup.rs}` | comments + docs citing `anomalyco/release` | cite the fork's release-service spec | The protocol *logic* (version compare, decide rules) stays unchanged — it must keep matching the manifest protocol. |
| 4 | `install`, `install.ps1` | `https://opencode.ai/browse/install[.ps1]`, `@opencode/browse` npm refs | `<FORK INSTALL URL>`, `@sjseo298/browse` | Installers download from the release service; point them at the fork service. |
| 5 | `README.md` | Anomaly's release service, `opencode.ai` links, install table | fork URLs, fork README identity | All user-facing paths must lead to sjseo298. |
| 6 | `RELEASING.md`, `rust/PLAN.md`, `rust/RELEASE.md` | Anomaly release service, `@opencode/browse`, CWS account | fork equivalents; CWS section: **skip** (no Anomaly CWS access) or sjseo298's own CWS item | Doc-only. |
| 7 | npm scope everywhere | `@opencode/browse`, `@opencode/browse-<target>` | `@sjseo298/browse`, `@sjseo298/browse-<target>` | In `rust/crates/browse/src/{agents.rs,update.rs}`, `rust/npm/package.json`, `cli/package.json`, and tests. Requires an npm account owning the `sjseo298` scope. |
| 8 | `public/manifest.json` | `"name": "OpenCode Browse"`, action title | `"sjseo298 Browse"` (or chosen fork name) | **Keep the `key`** while using the unpacked extension: the relay trusts the ID the key pins. Only get a new key (new ID) if the fork publishes its own CWS item; then update the relay's trust logic accordingly. |
| 9 | `.github/CODEOWNERS` | `@thdxr @R44VC0RP` | `@sjseo298` | Release security boundary stays scoped to the fork owner. |
| 10 | `scripts/release-registry.json` | publisher `anomalyco/browse` (repo IDs 1435849068/66570915) | `sjseo298/browse` + its IDs, or delete the file | Only meaningful if the fork runs its own release-service publisher. |
| 11 | `.github/workflows/release.yml` | publishes to Anomaly's release service / npm / CWS with Anomaly secrets | fork service + fork secrets, or delete (local-only fork needs no release pipeline) | Do not run the unmodified workflow. |
| 12 | ~~`scripts/cws-auth.ts`, `store/`~~ | Anomaly's Chrome Web Store account | **deleted in the first patch** (re-add upstream's only if sjseo298 gets its own CWS item) | The fork's extension is loaded **unpacked** locally. |
| 13 | Test fixtures: `cli/test/fixtures/release/*`, `rust/crates/browse/tests/fixtures/release/*`, `cli/test/{release-vectors,auto-update,dev-extension}.test.ts`, `rust/crates/browse/tests/package_update.rs` | `anoma.ly/...` URLs, `@opencode/browse` | keep URLs as **protocol test vectors** (they exercise the release-protocol client rules against sample manifests) unless the fork's service diverges; rebrand npm names in `package_update.rs` if #7 applies | These are spec-conformance vectors, not live endpoints — changing them blindly breaks `cargo test`. |
| 14 | Env prefix `OPENCODE_BROWSER_*` (≈60 vars) + Vite defines `__OPENCODE_BROWSER_BUILD__`, `__OPENCODE_BROWSER_TEST_HOOKS__` | — | **optional**: rename to `BROWSE_*` only as one fully consistent pass across `rust/`, `cli/`, `vite.config.ts`, tests | Pure internal identifier (no user-facing brand leak). Default: **keep** (low value, high churn, every upstream merge conflicts). |
| 15 | `@opencode/ui` dependency (`package.json`, extension pages) | — | **keep** (it's a UI kit package, not a reference to the agent) | Renaming would fork the UI library; not worth it. |
| 16 | Docs links to upstream opencode (e.g. `opencode.ai/v2/docs/mcp-servers` in README agent table) | upstream docs | `https://github.com/sjseo298/opencode` docs for the fork's improvements; upstream docs acceptable *as links to third-party docs* for other agents' MCP config | Distinguish "we are" (sjseo298) from "links to others' docs" (allowed). |
| 17 | `rust/crates/browse/src/method.rs` (install detection) | `@opencode` scope only | accept **both** `@sjseo298` and `@opencode` in `is_package`, `platform_binary`, `package_install`, the pnpm store candidates/links; npm registry flag `--@sjseo298:registry`; pnpm 11 test fixture `links/@sjseo298` | Behavior change, not just branding: a machine with a pre-fork upstream install (`node_modules/@opencode/browse`) must keep being detected. Re-apply after any upstream merge that touches `method.rs`. |
| 18 | `install`, `install.ps1` (manifest target URLs) | relative `/...` URLs only | accept **both** `https://...` absolute URLs and `/...` relative paths | Behavior change: GitHub Pages serves only the JSON manifests while binary tarballs are hosted as GitHub Releases assets (`https://github.com/sjseo298/browse/releases/download/...`); Rust `file_url()` (`update.rs:270`) already supports `https://`. Re-apply if upstream modifies URL checks in either installer. |
| 19 | `scripts/dist.ts` + `gh-pages` distribution | upstream GitHub Actions (`release.yml` + Anomaly release service + CWS) | 100% local build (`cargo build --release --locked`, unpacked extension zip keeping `manifest.key`) + `gh` publish (`v<version>` Release assets + `gh-pages` branch root with `.nojekyll`, `install`, `install.ps1`, `release/browse/cli/<channel>.json`) | `/release/` is gitignored on `dev`, so manifests live on `gh-pages` (`/`). Local prerequisite: `rustup` toolchain `1.99.1` + `x86_64-apple-darwin` target (and `gh` CLI). |

### Rebrand audit (must be clean after every merge)

```sh
grep -rn -i "anomalyco\|anoma\.ly\|@opencode/browse\|opencode\.ai" \
  --include='*.ts' --include='*.rs' --include='*.md' --include='*.json' \
  --include='*.yml' --include='*.ps1' --include='*.toml' . \
  | grep -v node_modules | grep -v '^./AGENTS.md'
```

Allowed residuals (update this list and this grep together if you change the rebranding):

1. Upstream-identity mentions **inside this file** (it documents the fork).
2. Protocol test vectors (#13): fixtures and the test files that assert the release-protocol
   client rules — they exercise sample manifests, not live endpoints.
3. Citations of the release-protocol **spec** (`anomalyco/release` docs) in code comments and
   `RELEASING.md` — the fork's service must implement that spec; the citation is the contract.
4. Pointers to upstream docs (e.g. the CWS procedure in `RELEASING.md` pointing at upstream's
   RELEASING.md) and third-party docs links (#16).
5. `changelog/` — historical upstream release notes.
6. `dist/` — build output (rebuilt from the rebranded sources).

Anything else is a merge that lost the fork patch — fix it before committing.

## 6. Upstream contracts — never break these

- **Extension ↔ relay WebSocket protocol** (`src/agent-relay/protocol.ts` ⇄
  `rust/crates/browse-relay/src/protocol.rs`). The store-published extension must keep working
  with the relay; protocol changes require coordinated extension + relay releases.
- **The manifest `key`** in `public/manifest.json`: pins the unpacked extension ID the relay
  trusts (`cli/src/setup/dev-extension.ts` checks it).
- **Release-protocol client rules** (`rust/crates/browse/src/protocol.rs`, mirrors
  `anomalyco/release`'s `src/protocol/decide.ts`): version-equality/channel logic must stay
  compatible with whatever release service the fork points at.
- **`cli/` as the spec**: when in doubt about intended behavior, the TypeScript reference is the
  spec the Rust code follows.
- **Stealth constraints** (`rust/PLAN.md`): no `Runtime.enable`/`Console.enable` by default,
  isolated worlds, no page globals. Don't "fix" behavior that trips bot challenges.

## 7. Definition of done for any change in this fork

1. `bun run typecheck` passes (extension + scripts).
2. `bun test ./test` passes (extension).
3. `cd rust && cargo test` passes (Rust).
4. §5 rebrand audit clean (no new Anomaly references outside the allow-list).
5. For extension changes: `bun run build` produces a `dist/` that loads unpacked and pairs
   (`browse pair` → code accepted on the status page).
6. Fork commits are scoped (branding vs feature) so `git diff upstream/dev...dev` stays reviewable.

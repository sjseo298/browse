// Local distribution builder and publisher for the sjseo298/browse fork (no GitHub Actions required):
//   bun scripts/dist.ts build    [--version <v>] [--channel <c>] [--out <dir>] [--target <t>]... [--skip-cargo]
//   bun scripts/dist.ts validate [--out <dir>] [--manifest <file>] [--channel <c>]
//   bun scripts/dist.ts publish  [--version <v>] [--channel <c>] [--out <dir>] [--repo <owner/name>] [--dry-run]
//   bun scripts/dist.ts all      [same options]   (build -> validate -> publish)
//
// Artifacts are built locally (cargo release binaries + unpacked extension zip keeping manifest `key`), then published
// via `gh`: binaries + extension zip as GitHub Release v<version> assets, and the channel manifest + install scripts on
// the `gh-pages` branch served at https://sjseo298.github.io/browse/release.
import { $ } from "bun"
import crypto from "node:crypto"
import { chmodSync, existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { decide, parseManifest, releaseChannel, serviceTarget, type ReleaseChannel } from "../cli/src/update/release-service.ts"
import { checkBinaryTarball } from "./check-artifacts.ts"
import { binaryProblems, releaseVersion, TARGETS, type Target } from "./npm-package.ts"
import { applyManifestVersion } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
const DEFAULT_REPO = "sjseo298/browse"

const TRIPLE_FOR_BUILD: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
}

function enhancedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  const cargoBin = path.join(os.homedir(), ".cargo", "bin")
  const currentPath = env.PATH ?? ""
  if (existsSync(cargoBin) && !currentPath.split(path.delimiter).includes(cargoBin)) {
    env.PATH = `${cargoBin}${path.delimiter}${currentPath}`
  }
  return { ...env, ...extra }
}

function defaultTargetsForHost(): string[] {
  if (process.platform === "darwin") {
    return ["darwin-arm64", "darwin-x64", "darwin-x64-baseline"]
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? ["linux-arm64"] : ["linux-x64", "linux-x64-baseline"]
  }
  throw new Error(`Unsupported host platform for local dist build: ${process.platform} (${process.arch}). Pass --target explicitly.`)
}

function resolveTargets(requested: readonly string[] | undefined): Target[] {
  const names = requested?.length ? requested : defaultTargetsForHost()
  return names.map((name) => {
    const found = TARGETS.find((item) => item.name === name)
    if (!found) throw new Error(`Unknown target ${JSON.stringify(name)}. Valid targets: ${TARGETS.map((t) => t.name).join(", ")}`)
    if (!TRIPLE_FOR_BUILD[found.build]) {
      throw new Error(`Target ${name} (build ${found.build}) is not supported for local builds by dist.ts`)
    }
    return found
  })
}

async function detectRepo(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const remote = await $`git remote get-url origin`.cwd(root).quiet().nothrow().text()
  const match = /github\.com[:/]([^/\s]+\/[^/\s.]+?)(?:\.git)?\s*$/.exec(remote.trim())
  return match?.[1] ?? DEFAULT_REPO
}

function pagesBaseUrl(repo: string): string {
  const [owner, name] = repo.split("/")
  return `https://${owner}.github.io/${name}`
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  hash.update(await readFile(filePath))
  return hash.digest("hex")
}

async function buildRustBinary(buildName: string, version: string): Promise<string> {
  const triple = TRIPLE_FOR_BUILD[buildName]
  if (!triple) throw new Error(`No Rust triple mapping for build ${buildName}`)
  const rustDir = path.join(root, "rust")
  const env = enhancedEnv({ BROWSE_VERSION: version })

  console.log(`→ Building Rust binary for ${buildName} (${triple}) with BROWSE_VERSION=${version}...`)
  await $`cargo build --release --locked -p browse --target ${triple}`.cwd(rustDir).env(env)

  const built = path.join(rustDir, "target", triple, "release", "browse")
  if (!existsSync(built)) throw new Error(`Expected Rust binary not found at ${built}`)
  const destDir = path.join(rustDir, "dist", buildName)
  await mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, "browse")
  await copyFile(built, dest)
  chmodSync(dest, 0o755)
  return dest
}

async function packBinaryTarball(item: Target, version: string, outDir: string): Promise<string> {
  const executable = item.os === "win32" ? "browse.exe" : "browse"
  const source = path.join(root, "rust", "dist", item.build, executable)
  const bytes = new Uint8Array(await readFile(source).catch(() => Buffer.alloc(0)))
  if (!bytes.length) throw new Error(`Missing built binary at ${source}`)

  const problems = binaryProblems(bytes, item, `${item.build}/${executable}`)
  if (problems.length) throw new Error(`Binary check failed:\n${problems.join("\n")}`)

  const tarballName = `opencode-browse-${item.name}-${version}.tgz`
  const outTarball = path.join(outDir, tarballName)
  const staging = await mkdtemp(path.join(os.tmpdir(), "browse-dist-tgz-"))
  try {
    const pkgDir = path.join(staging, "package")
    await mkdir(path.join(pkgDir, "bin"), { recursive: true })
    const binDest = path.join(pkgDir, "bin", executable)
    await copyFile(source, binDest)
    chmodSync(binDest, 0o755)
    await copyFile(path.join(root, "LICENSE"), path.join(pkgDir, "LICENSE"))
    const pkgJson = {
      name: `@sjseo298/browse-${item.name}`,
      version,
      description: `The browse binary for ${item.name}.`,
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/sjseo298/browse.git", directory: "rust" },
      os: [item.os],
      cpu: [item.cpu],
      ...(item.libc ? { libc: [item.libc] } : {}),
      publishConfig: { access: "public" },
    }
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n")
    await rm(outTarball, { force: true })
    // Emit only the exact 3 file entries (no directory entries, no macOS AppleDouble files) to match npm pack layout.
    await $`tar -czf ${outTarball} -C ${staging} package/package.json package/LICENSE package/bin/${executable}`.env(
      enhancedEnv({ COPYFILE_DISABLE: "1" }),
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  const tarballProblems = await checkBinaryTarball(outTarball, version, item.name)
  if (tarballProblems.length) throw new Error(`Tarball check failed:\n${tarballProblems.join("\n")}`)
  return outTarball
}

async function buildUnpackedExtensionZip(version: string, outDir: string): Promise<string> {
  const buildId = new Date().toISOString()
  console.log("→ Building extension (dist/) keeping manifest key for unpacked install...")
  await $`bun run build`.cwd(root).env(enhancedEnv({ OPENCODE_BROWSER_BUILD: buildId }))

  const staging = await mkdtemp(path.join(os.tmpdir(), "browse-dist-ext-"))
  const zipPath = path.join(outDir, `browse-extension-${version}.zip`)
  try {
    const distDir = path.join(root, "dist")
    await $`cp -R ${distDir}/. ${staging}`
    const manifestPath = path.join(staging, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    if (typeof manifest.key !== "string" || !manifest.key) {
      throw new Error("public/manifest.json must keep `key` so unpacked fork installs get the trusted extension ID")
    }
    applyManifestVersion(manifest, version)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    await rm(path.join(staging, "relay-pairing.json"), { force: true })
    await writeFile(path.join(staging, "build.json"), JSON.stringify({ build: buildId }) + "\n")
    await rm(zipPath, { force: true })
    await $`zip -qrX ${zipPath} . -x "*.map" -x ".DS_Store" -x "relay-pairing.json"`.cwd(staging).quiet()
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  const listing = (await $`unzip -Z1 ${zipPath}`.quiet().text()).split("\n").filter(Boolean)
  for (const required of ["manifest.json", "background.js", "content.js", "welcome.html", "onboarding.html", "settings.html"]) {
    if (!listing.includes(required)) throw new Error(`${path.basename(zipPath)} is missing ${required}`)
  }
  if (listing.some((entry) => entry === "relay-pairing.json" || entry.endsWith(".map"))) {
    throw new Error(`${path.basename(zipPath)} contains forbidden files (relay-pairing.json or .map)`)
  }
  return zipPath
}

type ChannelManifest = {
  schema: 1
  app: "browse"
  artifact: "cli"
  channel: ReleaseChannel
  sequence: number
  published_at: string
  release: {
    version: string
    notes_url: string
    rollout_percent: number
    targets: Record<string, { url: string; size: number; sha256: string }>
    distributions: { kind: string }[]
  }
}

function buildManifestObject(options: {
  version: string
  channel: ReleaseChannel
  repo: string
  sequence: number
  targets: Record<string, { url: string; size: number; sha256: string }>
}): ChannelManifest {
  return {
    schema: 1,
    app: "browse",
    artifact: "cli",
    channel: options.channel,
    sequence: options.sequence,
    published_at: new Date().toISOString(),
    release: {
      // Keep `version` first inside `release` for bash installer field parsing compatibility.
      version: options.version,
      notes_url: `https://github.com/${options.repo}/releases/tag/v${options.version}`,
      rollout_percent: 100,
      targets: options.targets,
      distributions: [{ kind: "direct" }],
    },
  }
}

async function cmdBuild(options: {
  version: string
  channel: ReleaseChannel
  outDir: string
  repo: string
  targets: Target[]
  skipCargo: boolean
}) {
  await mkdir(options.outDir, { recursive: true })

  if (!options.skipCargo) {
    const uniqueBuilds = [...new Set(options.targets.map((t) => t.build))]
    for (const buildName of uniqueBuilds) {
      await buildRustBinary(buildName, options.version)
    }
  }

  const targetEntries: Record<string, { url: string; size: number; sha256: string }> = {}
  const assetPaths: string[] = []

  for (const item of options.targets) {
    const tarball = await packBinaryTarball(item, options.version, options.outDir)
    const info = await stat(tarball)
    const sha256 = await sha256File(tarball)
    const filename = path.basename(tarball)
    const key = serviceTarget(item.name)
    targetEntries[key] = {
      url: `https://github.com/${options.repo}/releases/download/v${options.version}/${filename}`,
      size: info.size,
      sha256,
    }
    assetPaths.push(tarball)
    console.log(`✓ Packed ${filename} (${(info.size / 1024 / 1024).toFixed(2)} MB, sha256 ${sha256.slice(0, 12)}…)`)
  }

  const extZip = await buildUnpackedExtensionZip(options.version, options.outDir)
  const extInfo = await stat(extZip)
  const extSha = await sha256File(extZip)
  assetPaths.push(extZip)
  console.log(`✓ Packed ${path.basename(extZip)} (${(extInfo.size / 1024).toFixed(1)} KB, sha256 ${extSha.slice(0, 12)}…)`)

  const sumsLines = await Promise.all(assetPaths.map(async (file) => `${await sha256File(file)}  ${path.basename(file)}`))
  const sumsPath = path.join(options.outDir, "SHA256SUMS")
  await writeFile(sumsPath, sumsLines.join("\n") + "\n")

  const manifest = buildManifestObject({
    version: options.version,
    channel: options.channel,
    repo: options.repo,
    sequence: 1,
    targets: targetEntries,
  })
  const manifestPath = path.join(options.outDir, `manifest-${options.channel}.json`)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  console.log(`✓ Generated ${manifestPath}`)
  return { manifestPath, sumsPath, assetPaths }
}

async function cmdValidate(options: { manifestPath: string; outDir: string; previousVersion?: string }) {
  const raw = await readFile(options.manifestPath, "utf8")
  const parsed = parseManifest(JSON.parse(raw))
  if (!parsed) throw new Error(`parseManifest rejected ${options.manifestPath}`)

  const targetNames = Object.keys(parsed.release.targets)
  if (!targetNames.length) throw new Error(`Manifest ${options.manifestPath} has no targets`)

  const runningOld = options.previousVersion ?? (parsed.release.version === "0.1.6" ? "0.1.5" : "0.0.0-prev")
  if (runningOld === parsed.release.version) {
    throw new Error(`Previous test version (${runningOld}) matches manifest version (${parsed.release.version})`)
  }

  for (const target of targetNames) {
    const upgrade = decide({
      app: "browse",
      artifact: "cli",
      channel: parsed.channel,
      manifest: raw,
      install: {
        version: runningOld,
        target,
        distribution: "direct",
        rolloutBucket: 50,
      },
    })
    if (upgrade.action !== "install" || upgrade.version !== parsed.release.version) {
      throw new Error(`Expected decide(running=${runningOld}, target=${target}) -> install ${parsed.release.version}, got ${JSON.stringify(upgrade)}`)
    }
    if (!upgrade.target.url.startsWith("https://")) {
      throw new Error(`Expected https:// target URL for ${target}, got ${upgrade.target.url}`)
    }

    const same = decide({
      app: "browse",
      artifact: "cli",
      channel: parsed.channel,
      manifest: raw,
      install: {
        version: parsed.release.version,
        target,
        distribution: "direct",
        rolloutBucket: 50,
      },
    })
    if (same.action !== "none" || same.reason !== "up_to_date") {
      throw new Error(`Expected decide(running=${parsed.release.version}, target=${target}) -> none/up_to_date, got ${JSON.stringify(same)}`)
    }

    const filename = path.basename(new URL(upgrade.target.url).pathname)
    const localFile = path.join(options.outDir, filename)
    if (existsSync(localFile)) {
      const actualSize = (await stat(localFile)).size
      const actualSha = await sha256File(localFile)
      if (actualSize !== upgrade.target.size) {
        throw new Error(`${filename}: manifest size ${upgrade.target.size} != local file size ${actualSize}`)
      }
      if (actualSha !== upgrade.target.sha256) {
        throw new Error(`${filename}: manifest sha256 ${upgrade.target.sha256} != local sha256 ${actualSha}`)
      }
    }
    console.log(`✓ decide(${target}): ${runningOld} -> install ${upgrade.version}; ${parsed.release.version} -> up_to_date`)
  }
  console.log(`✓ Manifest ${options.manifestPath} validated (${targetNames.length} targets)`)
}

async function cmdPublish(options: {
  version: string
  channel: ReleaseChannel
  outDir: string
  repo: string
  dryRun: boolean
}) {
  const manifestPath = path.join(options.outDir, `manifest-${options.channel}.json`)
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath}. Run \`bun scripts/dist.ts build --version ${options.version}\` first.`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ChannelManifest
  if (manifest.release.version !== options.version) {
    throw new Error(`Manifest version (${manifest.release.version}) != requested version (${options.version})`)
  }

  // Validate before publishing anything.
  await cmdValidate({ manifestPath, outDir: options.outDir })

  const assets: string[] = []
  for (const target of Object.values(manifest.release.targets)) {
    const file = path.join(options.outDir, path.basename(new URL(target.url).pathname))
    if (!existsSync(file)) throw new Error(`Missing release asset ${file}`)
    assets.push(file)
  }
  const extZip = path.join(options.outDir, `browse-extension-${options.version}.zip`)
  if (existsSync(extZip)) assets.push(extZip)
  const sumsPath = path.join(options.outDir, "SHA256SUMS")
  if (existsSync(sumsPath)) assets.push(sumsPath)

  const tag = `v${options.version}`
  const ghPagesUrl = pagesBaseUrl(options.repo)
  if (options.dryRun) {
    console.log(`=== Dry Run: publish ${tag} (${options.channel}) to ${options.repo} ===`)
    console.log(`1. GitHub Release ${tag}: ${assets.map((a) => path.basename(a)).join(", ")}`)
    console.log(`2. gh-pages branch: release/browse/cli/${options.channel}.json, install, install.ps1, .nojekyll`)
    console.log(`3. GitHub Pages: ensure source=gh-pages path=/ (${ghPagesUrl}/release/browse/cli/${options.channel}.json)`)
    return
  }

  // Verify gh CLI auth and tag existence on remote.
  const auth = await $`gh auth status`.quiet().nothrow()
  if (auth.exitCode !== 0) throw new Error(`gh CLI is not authenticated:\n${auth.stderr.toString()}`)

  const remoteTag = await $`git ls-remote --tags origin refs/tags/${tag}`.cwd(root).quiet().text()
  if (!remoteTag.trim()) {
    throw new Error(`Tag ${tag} is not pushed to origin yet. Commit, run \`git tag ${tag}\`, and \`git push origin dev ${tag}\` before publishing.`)
  }

  // Step 1: Create or update GitHub Release (idempotent).
  const existingRelease = await $`gh release view ${tag} --repo ${options.repo}`.quiet().nothrow()
  if (existingRelease.exitCode === 0) {
    console.log(`→ Updating assets on existing GitHub Release ${tag}...`)
    await $`gh release upload ${tag} ${assets} --clobber --repo ${options.repo}`
  } else {
    console.log(`→ Creating GitHub Release ${tag} with ${assets.length} assets...`)
    const changelogFile = path.join(root, "changelog", `${options.version}.md`)
    const notesArgs = existsSync(changelogFile)
      ? ["--notes-file", changelogFile]
      : ["--notes", `Fork distribution v${options.version} (built locally; binaries for ${Object.keys(manifest.release.targets).join(", ")}).`]
    await $`gh release create ${tag} ${assets} --repo ${options.repo} --title ${tag} ${notesArgs}`
  }

  // Verify assets are actually listed on the release before publishing the manifest pointing to them.
  const releaseJson = (await $`gh release view ${tag} --repo ${options.repo} --json assets`.json()) as {
    assets: { name: string }[]
  }
  const uploadedNames = new Set(releaseJson.assets.map((a) => a.name))
  for (const file of assets) {
    if (!uploadedNames.has(path.basename(file))) {
      throw new Error(`Asset ${path.basename(file)} was not found on GitHub Release ${tag} after upload`)
    }
  }
  console.log(`✓ GitHub Release ${tag} verified (${releaseJson.assets.length} assets)`)

  // Step 2: Deploy channel manifest + installers to gh-pages branch (isolated temp clone).
  const remoteUrl = (await $`git remote get-url origin`.cwd(root).quiet().text()).trim()
  const gitUserName = (await $`git config user.name`.cwd(root).quiet().nothrow().text()).trim() || "sjseo298"
  const gitUserEmail = (await $`git config user.email`.cwd(root).quiet().nothrow().text()).trim() || "sjseo298@users.noreply.github.com"

  const pagesDir = await mkdtemp(path.join(os.tmpdir(), "browse-gh-pages-"))
  try {
    const hasGhPages = (await $`git ls-remote --heads origin gh-pages`.cwd(root).quiet().text()).trim().length > 0
    if (hasGhPages) {
      await $`git clone --depth 1 --branch gh-pages ${remoteUrl} ${pagesDir}`.quiet()
    } else {
      await $`git init -b gh-pages ${pagesDir}`.quiet()
      await $`git remote add origin ${remoteUrl}`.cwd(pagesDir).quiet()
    }
    await $`git config user.name ${gitUserName}`.cwd(pagesDir).quiet()
    await $`git config user.email ${gitUserEmail}`.cwd(pagesDir).quiet()

    const channelFileRel = path.join("release", "browse", "cli", `${options.channel}.json`)
    const channelFileAbs = path.join(pagesDir, channelFileRel)
    let sequence = 1
    if (existsSync(channelFileAbs)) {
      try {
        const prev = JSON.parse(await readFile(channelFileAbs, "utf8")) as Partial<ChannelManifest>
        if (typeof prev.sequence === "number" && prev.sequence >= 1) {
          const sameTargets = JSON.stringify(prev.release?.targets) === JSON.stringify(manifest.release.targets)
          const sameVersion = prev.release?.version === manifest.release.version
          sequence = sameVersion && sameTargets ? prev.sequence : prev.sequence + 1
        }
      } catch {
        sequence = 1
      }
    }
    manifest.sequence = sequence

    await mkdir(path.dirname(channelFileAbs), { recursive: true })
    await writeFile(path.join(pagesDir, ".nojekyll"), "")
    await writeFile(path.join(pagesDir, ".gitignore"), ".DS_Store\n")
    await copyFile(path.join(root, "install"), path.join(pagesDir, "install"))
    await copyFile(path.join(root, "install.ps1"), path.join(pagesDir, "install.ps1"))
    await writeFile(channelFileAbs, JSON.stringify(manifest, null, 2) + "\n")

    await $`git add -A`.cwd(pagesDir).quiet()
    const status = (await $`git status --porcelain`.cwd(pagesDir).quiet().text()).trim()
    if (!status) {
      console.log("✓ gh-pages is already up to date (no changes to push)")
    } else {
      await $`git commit -m ${`dist: publish browse v${options.version} (${options.channel})`}`.cwd(pagesDir).quiet()
      await $`git push origin gh-pages`.cwd(pagesDir)
      console.log(`✓ Pushed gh-pages (sequence ${sequence})`)
    }
  } finally {
    await rm(pagesDir, { recursive: true, force: true })
  }

  // Step 3: Ensure GitHub Pages is enabled on gh-pages (/).
  const pagesCheck = await $`gh api repos/${options.repo}/pages`.quiet().nothrow()
  if (pagesCheck.exitCode !== 0) {
    console.log("→ Enabling GitHub Pages (branch: gh-pages, path: /)...")
    await $`gh api -X POST repos/${options.repo}/pages -f source[branch]=gh-pages -f source[path]=/`.quiet()
    console.log("✓ GitHub Pages enabled")
  } else {
    const info = JSON.parse(pagesCheck.stdout.toString()) as { source?: { branch?: string; path?: string }; html_url?: string }
    console.log(`✓ GitHub Pages active (${info.source?.branch}:${info.source?.path} -> ${info.html_url ?? ghPagesUrl})`)
  }

  console.log(`\nDone:`)
  console.log(`  Release:  https://github.com/${options.repo}/releases/tag/${tag}`)
  console.log(`  Manifest: ${ghPagesUrl}/release/browse/cli/${options.channel}.json`)
  console.log(`  Install:  curl -fsSL ${ghPagesUrl}/install | bash`)
}

function printHelp() {
  console.log(`Usage: bun scripts/dist.ts <build|validate|publish|all> [options]

Commands:
  build      Compile Rust binary locally (cargo), pack tarballs + unpacked extension zip, emit manifest
  validate   Verify generated manifest against cli/src/update/release-service.ts decide() & local files
  publish    Create/update GitHub Release v<version> via gh, deploy gh-pages manifest, enable Pages
  all        Run build -> validate -> publish

Options:
  --version <v>     Release version (default: cli/package.json version)
  --channel <c>     Channel: stable | beta | dev (default: derived from version)
  --out <dir>       Output directory (default: release/dist-<version>)
  --target <t>      Target name (repeatable; default on macOS: darwin-arm64, darwin-x64, darwin-x64-baseline)
  --repo <o/r>      GitHub owner/repo (default: detected from origin, fallback sjseo298/browse)
  --manifest <f>    Manifest file for validate (default: <out>/manifest-<channel>.json)
  --previous <v>    Older version string for validate upgrade check (default: 0.1.5 or 0.0.0-prev)
  --skip-cargo      Skip cargo build (re-pack binaries already in rust/dist/)
  --dry-run         For publish/all: print planned GitHub mutations without executing them
  -h, --help        Show this help`)
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      channel: { type: "string" },
      out: { type: "string" },
      target: { type: "string", multiple: true },
      repo: { type: "string" },
      manifest: { type: "string" },
      previous: { type: "string" },
      "skip-cargo": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  const [command] = positionals
  if (values.help || !command) {
    printHelp()
    process.exit(values.help ? 0 : 2)
  }

  const version = values.version ?? (await releaseVersion())
  const channel: ReleaseChannel = releaseChannel(values.channel ?? (version.includes("-dev.") ? "dev" : version.includes("-beta.") ? "beta" : "stable"))
  const outDir = path.resolve(values.out ?? path.join(root, "release", `dist-${version}`))
  const repo = await detectRepo(values.repo)
  const targets = resolveTargets(values.target)

  if (command === "build") {
    await cmdBuild({ version, channel, outDir, repo, targets, skipCargo: values["skip-cargo"] })
  } else if (command === "validate") {
    const manifestPath = path.resolve(values.manifest ?? path.join(outDir, `manifest-${channel}.json`))
    await cmdValidate({ manifestPath, outDir, previousVersion: values.previous })
  } else if (command === "publish") {
    await cmdPublish({ version, channel, outDir, repo, dryRun: values["dry-run"] })
  } else if (command === "all") {
    const built = await cmdBuild({ version, channel, outDir, repo, targets, skipCargo: values["skip-cargo"] })
    await cmdValidate({ manifestPath: built.manifestPath, outDir, previousVersion: values.previous })
    await cmdPublish({ version, channel, outDir, repo, dryRun: values["dry-run"] })
  } else {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(2)
  }
}

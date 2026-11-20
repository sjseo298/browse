// Messages between the extension's pages (onboarding.html, settings.html) and the background service worker. The page holds
// one `chrome.runtime.connect({ name: STATUS_PORT })` port and watches the relay connection through it.

import type { PageStatus } from "../agent-relay/protocol"

/** The link to the browse relay, which runs agent sessions for the browse MCP server and CLI. */
export type AgentRelayStatus =
  /** No relay is running yet; the CLI or MCP server starts one on demand. */
  | "offline"
  | "connecting"
  | "connected"
  /** browse in another browser or profile holds the relay's connection. */
  | "conflict"
  /** The relay speaks another protocol version; updating both fixes it. */
  | "incompatible"
  /** Not paired with this relay yet: it needs a code from `browse pair`. */
  | "unpaired"
  /** The relay didn't pair: a wrong or used code, a revoked browser, an older relay, or a program posing as one. */
  | "untrusted"

/** What the next connection pairs with: this browser's token for the relay, a code to exchange for one, or nothing. */
export type PairingSource = "token" | "code" | "none"

export type AgentRelayState = {
  status: AgentRelayStatus
  pairing: PairingSource
  /** Tabs agents use, with their page status when an agent is working or waiting for the user. */
  tabs: { tabId: number; status?: PageStatus }[]
  /** A newer browse on the clone's remote branch, as the relay's update check found it, and the command to update. */
  update?: AgentRelayUpdate
  /** Settings the connected relay's environment variables fix (OPENCODE_BROWSER_AGENT_WINDOW, …). */
  overrides?: RelayOverrides
  /** How the connected relay's install updates (cli/src/auto-update.ts), as it reported it in `relay.settings`. */
  autoUpdate?: RelayAutoUpdate
  /** With status "incompatible": which side is behind, when the relay said (its protocol range, or the 4003 reason). */
  skew?: ProtocolSkew
  /** The relay refused the last pairing code (wrong, used, expired, or too many tries). */
  codeRejected?: boolean
  /** Install wrote a code into this unpacked build, so it pairs with this computer's relay by itself. */
  unpacked?: boolean
  /** Where the extension connects, `localhost:port` or `host:port`, and whether that's another computer. */
  relay: { address: string; remote: boolean }
  /** What the connected relay calls this browser; agents pass `id` to use it when several are connected. */
  browser?: { id: string; name: string }
  /** All configured relay connections (local + SSH/remote devcontainers) running simultaneously. */
  relays?: readonly RelayEntryState[]
  /** Which relay receives user tabs lent via the toolbar button (`local` or a relay id). */
  lendTarget?: string
}

export type RelayProfile = {
  readonly id: string
  readonly label: string
  /** Empty means automatic local loopback (127.0.0.1 + fallback port discovery). */
  readonly address: string
  readonly auto: boolean
  readonly enabled: boolean
}

export type RelayEntryState = {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly auto: boolean
  status: AgentRelayStatus
  pairing: PairingSource
  tabs: { tabId: number; status?: PageStatus }[]
  update?: AgentRelayUpdate
  overrides?: RelayOverrides
  autoUpdate?: RelayAutoUpdate
  skew?: ProtocolSkew
  codeRejected?: boolean
  unpacked?: boolean
  relay: { address: string; remote: boolean }
  browser?: { id: string; name: string }
}

/** chrome.storage.local, set on the status page: this browser's name for agents. Unset: "<browser> on <computer>". */
export const BROWSER_NAME_KEY = "browserName"

/** chrome.storage.local, legacy single-relay address key (migrated into RELAY_PROFILES_KEY). */
export const RELAY_ADDRESS_KEY = "agentRelayAddress"
/** chrome.storage.local: list of RelayProfile entries connected simultaneously. */
export const RELAY_PROFILES_KEY = "agentRelayProfiles"
/** chrome.storage.local: target relay id when lending a user tab with the toolbar button (`"all"` shares with all relays). */
export const LEND_TARGET_KEY = "agentRelayLendTarget"
export const LEND_TARGET_ALL = "all"
export const DEFAULT_LOCAL_RELAY_ID = "local"

export function defaultLocalRelayProfile(enabled = true): RelayProfile {
  return { id: DEFAULT_LOCAL_RELAY_ID, label: "Local", address: "", auto: true, enabled }
}

export function sanitizeRelayId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return slug || `relay-${Math.random().toString(36).slice(2, 8)}`
}

export function isValidRelayProfile(value: unknown): value is RelayProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.label === "string" &&
    typeof v.address === "string" &&
    typeof v.auto === "boolean" &&
    typeof v.enabled === "boolean"
  )
}

/**
 * Resolves configured relay profiles from storage, migrating legacy `agentRelayAddress` if `agentRelayProfiles` is
 * absent. Keeps an automatic `local` profile enabled unless the user explicitly had a non-empty legacy remote address.
 */
export function resolveRelayProfiles(stored: Record<string, unknown>): RelayProfile[] {
  const rawList = stored[RELAY_PROFILES_KEY]
  if (Array.isArray(rawList)) {
    const valid = rawList.filter(isValidRelayProfile)
    if (valid.length > 0) return valid
  }
  const legacyRaw = stored[RELAY_ADDRESS_KEY]
  const legacy = typeof legacyRaw === "string" ? legacyRaw.trim() : ""
  const parsed = relayAddress(legacy)
  if (!legacy || !parsed || (parsed.host === "127.0.0.1" && parsed.port === undefined)) {
    return [defaultLocalRelayProfile(true)]
  }
  const addr = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host
  return [
    defaultLocalRelayProfile(false),
    { id: "remote-1", label: parsed.host === "127.0.0.1" ? `Port ${parsed.port ?? 19988}` : parsed.host, address: addr, auto: false, enabled: true },
  ]
}

export function aggregateRelayState(
  profiles: readonly RelayProfile[],
  states: ReadonlyMap<string, AgentRelayState>,
  lendTarget: string,
): AgentRelayState {
  const relays: RelayEntryState[] = profiles.map((p) => {
    const s = states.get(p.id)
    if (s) {
      return {
        id: p.id,
        label: p.label,
        enabled: p.enabled,
        auto: p.auto,
        status: s.status,
        pairing: s.pairing,
        tabs: s.tabs,
        ...(s.update ? { update: s.update } : {}),
        ...(s.overrides ? { overrides: s.overrides } : {}),
        ...(s.autoUpdate ? { autoUpdate: s.autoUpdate } : {}),
        ...(s.skew ? { skew: s.skew } : {}),
        ...(s.codeRejected ? { codeRejected: s.codeRejected } : {}),
        ...(s.unpacked ? { unpacked: s.unpacked } : {}),
        relay: s.relay,
        ...(s.browser ? { browser: s.browser } : {}),
      }
    }
    return {
      id: p.id,
      label: p.label,
      enabled: p.enabled,
      auto: p.auto,
      status: "offline",
      pairing: "none",
      tabs: [],
      relay: { address: p.address || "localhost:19988", remote: !p.auto && !p.address.startsWith("127.0.0.1") },
    }
  })

  const enabled = relays.filter((r) => r.enabled)
  const connected = enabled.filter((r) => r.status === "connected")
  const incompatible = enabled.find((r) => r.status === "incompatible")
  const primary =
    connected.find((r) => r.id === DEFAULT_LOCAL_RELAY_ID) ??
    connected[0] ??
    enabled.find((r) => r.id === DEFAULT_LOCAL_RELAY_ID) ??
    enabled[0] ??
    relays[0]!

  const status = connected.length > 0 ? "connected" : incompatible ? "incompatible" : primary.status
  const tabsById = new Map<number, AgentRelayState["tabs"][number]>()
  for (const r of relays) {
    for (const tab of r.tabs) tabsById.set(tab.tabId, tab)
  }

  return {
    status,
    pairing: primary.pairing,
    tabs: Array.from(tabsById.values()),
    ...(primary.update ? { update: primary.update } : {}),
    ...(primary.overrides ? { overrides: primary.overrides } : {}),
    ...(primary.autoUpdate ? { autoUpdate: primary.autoUpdate } : {}),
    ...(primary.skew && status === "incompatible" ? { skew: primary.skew } : {}),
    ...(primary.codeRejected ? { codeRejected: true } : {}),
    ...(primary.unpacked ? { unpacked: true } : {}),
    relay: primary.relay,
    ...(primary.browser ? { browser: primary.browser } : {}),
    relays,
    lendTarget,
  }
}
export type RelayAddress = { host: string; port?: number }
/**
 * A typed or stored relay address (`100.64.0.2`, `devbox.tailnet.ts.net:19988`, `[fd7a::1]`, an optional `ws://`), or
 * undefined when it isn't one. Empty means this computer: `{ host: "127.0.0.1" }`.
 */
export function relayAddress(input: unknown): RelayAddress | undefined {
  if (input === undefined || input === null) return { host: "127.0.0.1" }
  if (typeof input !== "string") return undefined
  const value = input.trim().replace(/^wss?:\/\//i, "").replace(/\/(extension)?$/, "")
  if (value === "") return { host: "127.0.0.1" }
  try {
    const url = new URL(`ws://${value}`)
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname) return undefined
    // This computer, however it's written.
    const host = url.hostname === "localhost" || url.hostname === "[::1]" ? "127.0.0.1" : url.hostname
    return url.port ? { host, port: Number(url.port) } : { host }
  } catch {
    return undefined
  }
}

/** update-cli: this extension is newer than the relay; update-extension: it's older than the relay supports. */
export type ProtocolSkew = "update-cli" | "update-extension"

export type AutoUpdateMode = "on" | "notify" | "off"
export const autoUpdateMode = (value: unknown): AutoUpdateMode | undefined => (value === "on" || value === "notify" || value === "off" ? value : undefined)
/**
 * How this CLI was installed, as kinds extensions have always known: binary and npm global installs update themselves.
 * Older relays send only npm, checkout or other. A bun, pnpm, yarn or volta global install reads as binary (it updates
 * itself, and `browse update` updates it), a bunx, pnpm dlx or yarn dlx run as npx; `method` names it exactly.
 */
export type RelayInstall = "binary" | "npm" | "npx" | "checkout" | "other"
/** The exact install method a newer relay reports beside `install`. */
export type RelayInstallMethod =
  | "binary"
  | "npm"
  | "bun"
  | "pnpm"
  | "yarn"
  | "volta"
  | "npx"
  | "bunx"
  | "pnpm-dlx"
  | "yarn-dlx"
  | "checkout"
  | "other"
export const relayInstallMethods: readonly RelayInstallMethod[] = [
  "binary",
  "npm",
  "bun",
  "pnpm",
  "yarn",
  "volta",
  "npx",
  "bunx",
  "pnpm-dlx",
  "yarn-dlx",
  "checkout",
  "other",
]
/**
 * Installs that update themselves (the install script's binary, or a global install its package manager updates), whose
 * update mode the options page offers. Bun, pnpm, yarn and volta installs report `install: "binary"` for older pages.
 */
export const selfUpdatingInstall = (update: Pick<RelayAutoUpdate, "install" | "method"> | undefined): boolean =>
  update?.install === "npm" || update?.install === "binary"
/** The last installer attempt that failed, which version it was for, and when. */
export type RelayUpdateFailure = { message: string; at: string; version?: string; attempts?: number }
/** The relay's update state: an npm install updates itself; a checkout updates with `update`. */
export type RelayAutoUpdate = {
  install: RelayInstall
  method?: RelayInstallMethod
  /** The command that updates this install in a terminal (or switches one that can't update to one that can). */
  updateCommand?: string
  /** The command that runs the relay's CLI in a terminal: `browse` for a binary install, `npx @sjseo298/browse` for npm. */
  cli?: string
  mode: AutoUpdateMode
  effective: AutoUpdateMode
  overriddenBy?: string
  version?: string
  channel?: string
  latest?: string
  /** When the relay first saw `latest` (ISO 8601), so an update that never lands can be noticed. */
  latestAt?: string
  /** When the relay last checked for a release (ISO 8601). */
  checkedAt?: string
  pending?: string
  previous?: string
  lastError?: RelayUpdateFailure
}

/** An optional update that stayed pending this long is told to the user rather than waited on quietly. */
export const AUTO_UPDATE_PENDING_MS = 24 * 60 * 60 * 1000

export type CliUpdateNotice = {
  current: string
  latest: string
  /** Why the CLI is behind: the install can't update itself, updates are off/notify, the last attempt failed, or it stayed pending. */
  reason: "install" | "mode" | "failed" | "pending"
  /** The command that updates this install in a terminal. */
  command: string
}

/**
 * The command that updates a CLI install: the relay's own when it names one; else binary and checkout update in place,
 * npm global and npx install the latest package.
 */
export function cliUpdateCommand(update: Pick<RelayAutoUpdate, "install" | "cli" | "updateCommand">): string {
  if (update.updateCommand?.trim()) return update.updateCommand.trim()
  if (update.install === "npm") return "npm install -g @sjseo298/browse@latest"
  if (update.install === "npx") return "npx @sjseo298/browse@latest install"
  return `${update.cli?.trim() || "browse"} update`
}

/** Orders the relay's versions as semver does for these shapes: dev below beta below the release, then by run. */
function versionOrder(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|beta)\.(\d+)(?:\.(\d+))?)?$/.exec(value)
  if (!match) return undefined
  const stage = match[4] === undefined ? 2 : match[4] === "beta" ? 1 : 0
  return [Number(match[1]), Number(match[2]), Number(match[3]), stage, Number(match[5] ?? 0), Number(match[6] ?? 0)]
}

/** Whether `latest` names another build than `current`, ordering known version shapes and treating anything else as different. */
export function newerCliVersion(latest: string, current: string): boolean {
  if (latest === current) return false
  const a = versionOrder(latest)
  const b = versionOrder(current)
  if (!a || !b) return true
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! > b[index]!
  return false
}

/**
 * The CLI update the status pages and toolbar should mention, or undefined while there's nothing to say. A normal
 * pending auto-update stays quiet: only an install that can't update itself, updates that are off or notify-only, a
 * failed attempt, or a release that stayed uninstalled for a day is told to the user.
 */
export function cliUpdateNotice(update: RelayAutoUpdate | undefined, now = Date.now()): CliUpdateNotice | undefined {
  const { version: current, latest } = update ?? {}
  if (!update || !current || !latest || !newerCliVersion(latest, current)) return undefined
  const failed = update.lastError !== undefined && (update.lastError.version === undefined || update.lastError.version === latest)
  const selfUpdating = update.install === "binary" || update.install === "npm"
  const since = update.latestAt === undefined ? undefined : Date.parse(update.latestAt)
  const stale = since !== undefined && Number.isFinite(since) && now - since > AUTO_UPDATE_PENDING_MS
  const reason = failed ? "failed" : !selfUpdating ? "install" : update.effective !== "on" ? "mode" : stale ? "pending" : undefined
  if (!reason) return undefined
  return { current, latest, reason, command: cliUpdateCommand(update) }
}

export type AgentRelayUpdate = { summary: string; command: string }

/** chrome.runtime.sendMessage request from an extension page; the worker answers with `{ text }`. */
export const AGENT_DIAGNOSTICS = "agents.diagnostics"

/** chrome.storage.local, set on the status page: where agents open new tabs, "current" (default) or "separate". */
export const AGENT_WINDOW_KEY = "agentTabsWindow"
export type AgentWindowPlacement = "current" | "separate"
export const agentWindowPlacement = (value: unknown): AgentWindowPlacement => (value === "separate" ? "separate" : "current")

// The status page's other settings, all in chrome.storage.local. Each applies from the moment it changes (new tabs,
// the next cleanup, the next handoff or input); a missing or unknown value reads as the default.

/** How agent tabs are grouped: one shared group for every agent (default), one group per agent session, or none. */
export const AGENT_GROUPING_KEY = "agentTabsGrouping"
export type AgentGrouping = "session" | "shared" | "none"
export const agentGrouping = (value: unknown): AgentGrouping => (value === "session" || value === "none" ? value : "shared")

/** Whether browse collapses agent groups by itself: "auto" (default), or "off" to leave each group as the user set it. */
export const AGENT_GROUP_COLLAPSE_KEY = "agentTabsGroupCollapse"
export type AgentGroupCollapse = "auto" | "off"
export const agentGroupCollapse = (value: unknown): AgentGroupCollapse => (value === "off" ? "off" : "auto")

/** Minutes an agent tab may sit untouched before it closes; 0 never closes them automatically. */
export const IDLE_MINUTES_KEY = "tabCleanupIdleMinutes"
export const DEFAULT_IDLE_MINUTES = 10
export const idleMinutesSetting = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_MINUTES

/** Whether the relay sends human-like input (curved paths, paced keys): "on" (default) or "off". */
export const HUMAN_INPUT_KEY = "humanInput"
export type HumanInput = "on" | "off"
export const humanInput = (value: unknown): HumanInput => (value === "off" ? "off" : "on")

/** Whether tabs agents open are muted: "on", or "off" (default). */
export const MUTE_TABS_KEY = "muteTabs"
export type MuteTabs = "on" | "off"
export const muteTabs = (value: unknown): MuteTabs => (value === "on" ? "on" : "off")

/** When a handoff shows a system notification: only on a recorded tab (default), or on every handoff. */
export const HANDOFF_NOTIFICATIONS_KEY = "handoffNotifications"
export type HandoffNotifications = "recording" | "always"
export const handoffNotifications = (value: unknown): HandoffNotifications => (value === "always" ? "always" : "recording")

/** The settings the relay applies, sent to it after pairing and whenever they change (the `settings` event). */
export type RelaySettings = { humanInput: HumanInput }

/** Settings the relay's environment fixes, whatever the status page says (the relay's `relay.settings` answer). */
export type RelayOverrides = { agentWindow?: "current" | "separate"; humanInput?: HumanInput }

export const STATUS_PORT = "opencode-browser.status"

export type ToStatusPage =
  | { type: "agents"; state: AgentRelayState }
  | { type: "pairing.link.result"; ok: boolean }
  /** The outcome of `relay.connect` / `relay.add`: the status the new connection settled on, or why nothing was tried. */
  | { type: "relay.result"; id?: string; status: AgentRelayStatus | "invalid-address" | "invalid-code"; address?: string }
export type FromStatusPage =
  /** Save the relay address (empty or localhost: this computer) and, when given, a pairing code; reconnect and report how it went. */
  | { type: "relay.connect"; id?: string; address: string; code: string; label?: string }
  | { type: "relay.add"; label?: string; address: string; code?: string }
  | { type: "relay.remove"; id: string }
  | { type: "relay.toggle"; id: string; enabled: boolean }
  | { type: "relay.setLendTarget"; id: string }
  | { type: "agents.reconnect"; id?: string }
  | { type: "tabs.cleanup" }
  /** A one-time code from install's link (welcome.html#code=… or #add=…), and the relay port/address. */
  | { type: "pairing.link"; code: string; port?: number; address?: string; label?: string }
  | { type: "autoUpdate.set"; id?: string; mode: AutoUpdateMode }

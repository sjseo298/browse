// Multi-relay pool: runs one createAgentRelay() instance per enabled RelayProfile simultaneously so local OpenCode
// (Mac) and remote OpenCode instances (SSH-tunneled devcontainers) can share this browser without interfering.
import { extensionReconnectAlarmPeriodMs, isJsonObject } from "../agent-relay/protocol"
import {
  aggregateRelayState,
  DEFAULT_LOCAL_RELAY_ID,
  defaultLocalRelayProfile,
  LEND_TARGET_ALL,
  LEND_TARGET_KEY,
  RELAY_ADDRESS_KEY,
  RELAY_PROFILES_KEY,
  relayAddress,
  resolveRelayProfiles,
  sanitizeRelayId,
  type AgentRelayState,
  type AutoUpdateMode,
  type RelayProfile,
} from "../shared/protocol"
import { createAgentRelay, type AgentBadge } from "./agent-relay"
import { ALARM, CODE_PORT_KEY, PAIRING_KEY, relayStorageKey, SESSION_GROUPS_KEY, SPENT_KEY } from "./agent-relay/wire"
import { DebuggerHub } from "./debugger-hub"
import { TabCleanup } from "./tab-cleanup"

const TAB_OWNERS_KEY = "agentRelayTabOwners"
const SHARED_TABS_KEY = "agentRelaySharedTabs"
const PENDING_KEY = "agentRelayPendingClicks"

type RelayInstance = ReturnType<typeof createAgentRelay>

export { aggregateRelayState }

export function createRelayPool(input: { changed: (state: AgentRelayState) => void; badgesChanged: () => void }) {
  let profiles: RelayProfile[] = [defaultLocalRelayProfile(true)]
  let lendTarget: string = DEFAULT_LOCAL_RELAY_ID
  const instances = new Map<string, RelayInstance>()
  const states = new Map<string, AgentRelayState>()
  const tabOwners = new Map<number, Set<string>>()
  const sharedTabs = new Set<number>()
  let ownersWrite: Promise<unknown> = Promise.resolve()

  const persistTabOwners = () => {
    const obj = Object.fromEntries(
      Array.from(tabOwners)
        .filter(([, ids]) => ids.size > 0)
        .map(([tabId, ids]) => [String(tabId), Array.from(ids)]),
    )
    const shared = Array.from(sharedTabs)
    ownersWrite = ownersWrite
      .then(() => chrome.storage.local.set({ [TAB_OWNERS_KEY]: obj, [SHARED_TABS_KEY]: shared }))
      .catch(() => undefined)
  }

  const persistProfiles = async (next: RelayProfile[]) => {
    profiles = next
    await chrome.storage.local.set({ [RELAY_PROFILES_KEY]: next })
  }

  const snapshot = (): AgentRelayState => {
    const effectiveLend =
      lendTarget === LEND_TARGET_ALL || profiles.some((p) => p.id === lendTarget && p.enabled)
        ? lendTarget
        : (profiles.find((p) => p.enabled)?.id ?? DEFAULT_LOCAL_RELAY_ID)
    return aggregateRelayState(profiles, states, effectiveLend)
  }

  const broadcast = () => input.changed(snapshot())

  const isKnownRelayTab = (tabId: number) => {
    for (const inst of instances.values()) {
      if (inst.ownsTab(tabId)) return true
    }
    return false
  }

  const findOwners = (tabId: number): RelayInstance[] => {
    const live = Array.from(instances.values()).filter((inst) => inst.ownsTab(tabId))
    if (live.length > 0) return live
    const stored = tabOwners.get(tabId)
    if (!stored) return []
    return Array.from(stored)
      .map((id) => instances.get(id))
      .filter((inst): inst is RelayInstance => inst !== undefined)
  }

  const spawnRelay = (profile: RelayProfile) => {
    const existing = instances.get(profile.id)
    if (existing) {
      existing.setProfile(profile)
      return existing
    }
    const inst = createAgentRelay({
      profile,
      managedLifecycle: true,
      isKnownRelayTab,
      tabConflict: (tabId) => {
        if (sharedTabs.has(tabId)) return undefined
        for (const [otherId, other] of instances) {
          if (otherId !== profile.id && other.ownsTab(tabId)) return other.profile().label
        }
        return undefined
      },
      canDetachTab: (tabId) => {
        for (const [otherId, other] of instances) {
          if (otherId !== profile.id && other.ownsTab(tabId)) return false
        }
        return true
      },
      onTabOwned: (tabId) => {
        const set = tabOwners.get(tabId) ?? new Set<string>()
        set.add(profile.id)
        tabOwners.set(tabId, set)
        persistTabOwners()
      },
      onTabReleased: (tabId) => {
        const set = tabOwners.get(tabId)
        if (set?.delete(profile.id)) {
          if (set.size === 0) {
            tabOwners.delete(tabId)
            sharedTabs.delete(tabId)
          }
          persistTabOwners()
        } else if (sharedTabs.has(tabId)) {
          const stillOwned = Array.from(instances.values()).some((other) => other !== inst && other.ownsTab(tabId))
          if (!stillOwned) {
            sharedTabs.delete(tabId)
            persistTabOwners()
          }
        }
      },
      updateProfileAddress: async (address) => {
        const next = profiles.map((p) => (p.id === profile.id ? { ...p, address, auto: profile.id === DEFAULT_LOCAL_RELAY_ID && address === "" } : p))
        await persistProfiles(next)
        const updated = next.find((p) => p.id === profile.id)
        if (updated) inst.setProfile(updated)
      },
      changed: (s) => {
        states.set(profile.id, s)
        broadcast()
      },
      badgesChanged: input.badgesChanged,
    })
    instances.set(profile.id, inst)
    states.set(profile.id, inst.state())
    return inst
  }

  const syncInstances = async (nextProfiles: RelayProfile[], options: { startImmediately?: boolean } = {}) => {
    const nextIds = new Set(nextProfiles.filter((p) => p.enabled).map((p) => p.id))
    for (const [id, inst] of Array.from(instances)) {
      if (!nextIds.has(id)) {
        instances.delete(id)
        states.delete(id)
        await inst.destroy({ detachTabs: true })
      }
    }
    for (const p of nextProfiles) {
      if (!p.enabled) continue
      const existed = instances.has(p.id)
      const inst = spawnRelay(p)
      if (!existed && options.startImmediately) inst.restoreOwnedTabs([])
    }
    broadcast()
  }

  const pickLendRelay = (explicitId?: string): RelayInstance | undefined => {
    if (explicitId) {
      const target = instances.get(explicitId)
      if (target) return target
    }
    const preferred = instances.get(lendTarget)
    if (preferred && preferred.state().status === "connected") return preferred
    for (const inst of instances.values()) {
      if (inst.state().status === "connected") return inst
    }
    return preferred ?? instances.get(DEFAULT_LOCAL_RELAY_ID) ?? instances.values().next().value
  }

  const pickLendRelays = (explicitId?: string): RelayInstance[] => {
    if (explicitId === LEND_TARGET_ALL || (!explicitId && lendTarget === LEND_TARGET_ALL)) {
      const connected = Array.from(instances.values()).filter((inst) => inst.state().status === "connected")
      return connected.length > 0 ? connected : Array.from(instances.values())
    }
    const single = pickLendRelay(explicitId)
    return single ? [single] : []
  }

  const ready = (async () => {
    const stored = await chrome.storage.local.get([
      RELAY_PROFILES_KEY,
      RELAY_ADDRESS_KEY,
      LEND_TARGET_KEY,
      TAB_OWNERS_KEY,
      SHARED_TABS_KEY,
    ])
    profiles = resolveRelayProfiles(stored)
    if (!Array.isArray(stored[RELAY_PROFILES_KEY])) {
      await chrome.storage.local.set({ [RELAY_PROFILES_KEY]: profiles })
    }
    if (
      typeof stored[LEND_TARGET_KEY] === "string" &&
      (stored[LEND_TARGET_KEY] === LEND_TARGET_ALL || profiles.some((p) => p.id === stored[LEND_TARGET_KEY]))
    ) {
      lendTarget = stored[LEND_TARGET_KEY]
    } else if (profiles.some((p) => p.id === DEFAULT_LOCAL_RELAY_ID && p.enabled)) {
      lendTarget = DEFAULT_LOCAL_RELAY_ID
    } else {
      lendTarget = profiles.find((p) => p.enabled)?.id ?? profiles[0]?.id ?? DEFAULT_LOCAL_RELAY_ID
    }
    if (Array.isArray(stored[SHARED_TABS_KEY])) {
      for (const id of stored[SHARED_TABS_KEY]) {
        if (typeof id === "number" && Number.isInteger(id)) sharedTabs.add(id)
      }
    }
    if (isJsonObject(stored[TAB_OWNERS_KEY])) {
      for (const [k, v] of Object.entries(stored[TAB_OWNERS_KEY])) {
        const tabId = Number(k)
        if (!Number.isInteger(tabId)) continue
        if (typeof v === "string") {
          tabOwners.set(tabId, new Set([v]))
        } else if (Array.isArray(v)) {
          const ids = v.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          if (ids.length > 0) tabOwners.set(tabId, new Set(ids))
        }
      }
    }

    for (const p of profiles) {
      if (p.enabled) spawnRelay(p)
    }

    await DebuggerHub.restore()
    const attached = DebuggerHub.attachedTabs()
    const byRelay = new Map<string, number[]>()
    for (const tabId of attached) {
      const saved = tabOwners.get(tabId)
      const activeIds = saved ? Array.from(saved).filter((id) => instances.has(id)) : []
      const fallbackId = instances.has(DEFAULT_LOCAL_RELAY_ID)
        ? DEFAULT_LOCAL_RELAY_ID
        : profiles.find((p) => p.enabled)?.id
      const targetIds = activeIds.length > 0 ? activeIds : fallbackId ? [fallbackId] : []
      if (targetIds.length === 0) continue
      tabOwners.set(tabId, new Set(targetIds))
      for (const targetId of targetIds) {
        const list = byRelay.get(targetId) ?? []
        list.push(tabId)
        byRelay.set(targetId, list)
      }
    }
    // Prune dead tab owners no longer attached after restore.
    const attachedSet = new Set(attached)
    for (const tabId of Array.from(tabOwners.keys())) {
      if (!attachedSet.has(tabId)) tabOwners.delete(tabId)
    }
    for (const tabId of Array.from(sharedTabs)) {
      if (!attachedSet.has(tabId)) sharedTabs.delete(tabId)
    }
    persistTabOwners()

    for (const [id, inst] of instances) {
      inst.restoreOwnedTabs(byRelay.get(id) ?? [])
    }

    await Promise.all([
      TabCleanup.reconcileCreates(isKnownRelayTab).catch(() => []),
      TabCleanup.closeUnattached(isKnownRelayTab).catch(() => []),
    ])

    void chrome.alarms.create(ALARM, { periodInMinutes: extensionReconnectAlarmPeriodMs / 60_000 })
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== ALARM) return
      for (const inst of instances.values()) inst.triggerAlarm()
    })
    broadcast()
  })()

  return {
    state: snapshot,
    badge: (tabId: number): AgentBadge | undefined => {
      let fallback: AgentBadge | undefined
      for (const inst of instances.values()) {
        const b = inst.badge(tabId)
        if (b === undefined) continue
        if (b.text === "WAIT" || b.text === "RUN") return b
        fallback ??= b
      }
      return fallback
    },
    async attachTab(tabId: number, targetRelayId?: string) {
      await ready
      const currentOwners = Array.from(instances.values()).filter((inst) => inst.ownsTab(tabId))
      if (currentOwners.length > 0) {
        if (targetRelayId === undefined) {
          await Promise.all(currentOwners.map((inst) => inst.attachTab(tabId)))
          return
        }
        if (targetRelayId === LEND_TARGET_ALL) {
          const allTargets = pickLendRelays(LEND_TARGET_ALL)
          const missing = allTargets.filter((inst) => !inst.ownsTab(tabId))
          if (missing.length > 0) {
            sharedTabs.add(tabId)
            persistTabOwners()
            await Promise.all(missing.map((inst) => inst.attachTab(tabId)))
          } else {
            await Promise.all(currentOwners.map((inst) => inst.attachTab(tabId)))
          }
          return
        }
        const explicit = instances.get(targetRelayId)
        if (!explicit) return
        if (explicit.ownsTab(tabId)) {
          await explicit.attachTab(tabId)
        } else {
          sharedTabs.add(tabId)
          persistTabOwners()
          await explicit.attachTab(tabId)
        }
        return
      }
      const targets = pickLendRelays(targetRelayId)
      if (targets.length === 0) return
      if (targets.length > 1 || targetRelayId === LEND_TARGET_ALL || (!targetRelayId && lendTarget === LEND_TARGET_ALL)) {
        sharedTabs.add(tabId)
      } else {
        sharedTabs.delete(tabId)
      }
      persistTabOwners()
      await Promise.all(targets.map((inst) => inst.attachTab(tabId)))
    },
    runtimeMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) {
      if (!isJsonObject(message)) return undefined
      const tabId = sender.tab?.id
      if (typeof tabId === "number") {
        const owners = findOwners(tabId)
        if (owners.length > 0) {
          let handled: boolean | undefined
          for (const owner of owners) {
            const res = owner.runtimeMessage(message, sender, sendResponse)
            if (res !== undefined) handled = res
          }
          if (handled !== undefined) return handled
        }
      }
      for (const inst of instances.values()) {
        const res = inst.runtimeMessage(message, sender, sendResponse)
        if (res !== undefined) return res
      }
      return undefined
    },
    async connectTo(address: string, code: string, id?: string, label?: string) {
      await ready
      const targetId = id ?? (profiles.some((p) => p.id === DEFAULT_LOCAL_RELAY_ID) ? DEFAULT_LOCAL_RELAY_ID : profiles[0]?.id)
      const existing = targetId ? instances.get(targetId) : undefined
      if (existing) {
        if (label !== undefined && label.trim()) {
          const next = profiles.map((p) => (p.id === targetId ? { ...p, label: label.trim().slice(0, 40) } : p))
          await persistProfiles(next)
          const updated = next.find((p) => p.id === targetId)
          if (updated) existing.setProfile(updated)
        }
        const result = await existing.connectTo(address, code)
        return { id: targetId, ...result }
      }
      if (targetId && profiles.some((p) => p.id === targetId)) {
        const next = profiles.map((p) => (p.id === targetId ? { ...p, enabled: true, ...(label?.trim() ? { label: label.trim().slice(0, 40) } : {}) } : p))
        await persistProfiles(next)
        await syncInstances(next, { startImmediately: false })
        const spawned = instances.get(targetId)
        if (spawned) {
          const result = await spawned.connectTo(address, code)
          return { id: targetId, ...result }
        }
      }
      return this.addRelay({ label, address, code })
    },
    async addRelay(params: { label?: string; address: string; code?: string }) {
      await ready
      const parsed = relayAddress(params.address)
      if (!parsed || !params.address.trim()) return { status: "invalid-address" as const }
      const normalized = parsed.port ? `${parsed.host}:${parsed.port}` : `${parsed.host}:19988`
      const cleanLabel = params.label?.trim().slice(0, 40) || (parsed.host === "127.0.0.1" ? `Port ${parsed.port ?? 19988}` : parsed.host)

      // Reuse an existing non-local profile pointing at the exact same host:port.
      const match = profiles.find((p) => {
        if (p.auto) return false
        const other = relayAddress(p.address)
        const otherNorm = other ? `${other.host}:${other.port ?? 19988}` : ""
        return otherNorm === normalized
      })
      if (match) {
        const next = profiles.map((p) => (p.id === match.id ? { ...p, label: params.label?.trim() ? cleanLabel : p.label, enabled: true } : p))
        await persistProfiles(next)
        await syncInstances(next, { startImmediately: false })
        const inst = instances.get(match.id)!
        const result = await inst.connectTo(normalized, params.code ?? "")
        return { id: match.id, ...result }
      }

      const baseId = sanitizeRelayId(cleanLabel)
      let id = baseId
      let suffix = 2
      while (profiles.some((p) => p.id === id)) {
        id = `${baseId}-${suffix++}`
      }
      const created: RelayProfile = { id, label: cleanLabel, address: normalized, auto: false, enabled: true }
      const next = [...profiles, created]
      await persistProfiles(next)
      const inst = spawnRelay(created)
      const result = await inst.connectTo(normalized, params.code ?? "")
      return { id, ...result }
    },
    async removeRelay(id: string) {
      await ready
      if (id === DEFAULT_LOCAL_RELAY_ID) return false
      if (!profiles.some((p) => p.id === id)) return false
      const next = profiles.filter((p) => p.id !== id)
      await persistProfiles(next)
      if (lendTarget === id) {
        lendTarget = next.find((p) => p.enabled)?.id ?? DEFAULT_LOCAL_RELAY_ID
        await chrome.storage.local.set({ [LEND_TARGET_KEY]: lendTarget })
      }
      await syncInstances(next, { startImmediately: true })
      await Promise.all([
        chrome.storage.local.remove([
          relayStorageKey(PAIRING_KEY, id),
          relayStorageKey(CODE_PORT_KEY, id),
          relayStorageKey(SPENT_KEY, id),
          relayStorageKey(SESSION_GROUPS_KEY, id),
        ]),
        chrome.storage.session.remove(relayStorageKey(PENDING_KEY, id)),
      ]).catch(() => undefined)
      return true
    },
    async toggleRelay(id: string, enabled: boolean) {
      await ready
      if (!profiles.some((p) => p.id === id)) return false
      const next = profiles.map((p) => (p.id === id ? { ...p, enabled } : p))
      await persistProfiles(next)
      await syncInstances(next, { startImmediately: true })
      return true
    },
    async setLendTarget(id: string) {
      await ready
      if (id !== LEND_TARGET_ALL && !profiles.some((p) => p.id === id)) return false
      lendTarget = id
      await chrome.storage.local.set({ [LEND_TARGET_KEY]: id })
      broadcast()
      return true
    },
    async pairLink(code: string, port?: number, address?: string, label?: string) {
      await ready
      if (address) {
        const parsed = relayAddress(address)
        if (!parsed) return false
        const normalized = parsed.port ? `${parsed.host}:${parsed.port}` : `${parsed.host}:19988`
        const existing = profiles.find((p) => {
          if (p.auto) return false
          const o = relayAddress(p.address)
          return o && `${o.host}:${o.port ?? 19988}` === normalized
        })
        if (existing && instances.get(existing.id)?.state().status === "connected") {
          return false
        }
        const res = await this.addRelay({ label, address: normalized, code })
        return res.status === "connected" || res.status === "connecting"
      }
      const localInst = instances.get(DEFAULT_LOCAL_RELAY_ID) ?? instances.values().next().value
      if (!localInst) return false
      return localInst.pairLink(code, port)
    },
    reconnect(id?: string) {
      if (id) {
        instances.get(id)?.reconnect()
        return
      }
      for (const inst of instances.values()) inst.reconnect()
    },
    setAutoUpdate(mode: AutoUpdateMode, id?: string) {
      if (id) {
        instances.get(id)?.setAutoUpdate(mode)
        return
      }
      for (const inst of instances.values()) inst.setAutoUpdate(mode)
    },
    async diagnostics() {
      await ready
      const sections: string[] = []
      for (const p of profiles) {
        const inst = instances.get(p.id)
        if (!inst) {
          sections.push(`=== Relay [${p.id}] "${p.label}" (${p.address || "auto"}) [disabled] ===`)
          continue
        }
        sections.push(`=== Relay [${p.id}] "${p.label}" ===\n${await inst.diagnostics()}`)
      }
      return sections.join("\n\n")
    },
  }
}

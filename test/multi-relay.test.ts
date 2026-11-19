import { describe, expect, test } from "bun:test"
import {
  aggregateRelayState,
  DEFAULT_LOCAL_RELAY_ID,
  RELAY_ADDRESS_KEY,
  RELAY_PROFILES_KEY,
  resolveRelayProfiles,
  type AgentRelayState,
  type RelayProfile,
} from "../src/shared/protocol.ts"
import {
  GROUP_COLOR,
  groupTitle,
  ownedGroup,
  relayGroupColor,
  relayStorageKey,
  sharedGroup,
  sharedTitle,
} from "../src/background/agent-relay/wire.ts"
import { relayTarget } from "../src/background/agent-relay/discovery.ts"
import { pairingLink } from "../src/status/pairing-link.ts"

describe("multi-relay protocol & storage migration", () => {
  test("resolves default local profile when storage is empty", () => {
    expect(resolveRelayProfiles({})).toEqual([
      { id: DEFAULT_LOCAL_RELAY_ID, label: "Local", address: "", auto: true, enabled: true },
    ])
  })

  test("migrates legacy remote agentRelayAddress into disabled local + enabled remote-1", () => {
    const profiles = resolveRelayProfiles({ [RELAY_ADDRESS_KEY]: "100.64.0.2:19988" })
    expect(profiles).toEqual([
      { id: DEFAULT_LOCAL_RELAY_ID, label: "Local", address: "", auto: true, enabled: false },
      { id: "remote-1", label: "100.64.0.2", address: "100.64.0.2:19988", auto: false, enabled: true },
    ])
  })

  test("preserves existing agentRelayProfiles over legacy key", () => {
    const saved: RelayProfile[] = [
      { id: "local", label: "Mac Local", address: "", auto: true, enabled: true },
      { id: "oipa", label: "OIPA", address: "127.0.0.1:29980", auto: false, enabled: true },
    ]
    expect(resolveRelayProfiles({ [RELAY_PROFILES_KEY]: saved, [RELAY_ADDRESS_KEY]: "10.0.0.1" })).toEqual(saved)
  })

  test("scopes storage keys and group styling per relay without breaking local", () => {
    expect(relayStorageKey("agentRelayPairingCode", "local")).toBe("agentRelayPairingCode")
    expect(relayStorageKey("agentRelayPairingCode", "oipa")).toBe("agentRelayPairingCode:oipa")
    expect(relayGroupColor("local")).toBe(GROUP_COLOR)
    expect(relayGroupColor("oipa")).not.toBe(GROUP_COLOR)

    const localShared = sharedTitle(2)
    const oipaShared = sharedTitle(1, "OIPA")
    expect(ownedGroup(localShared)).toBe(true)
    expect(ownedGroup(oipaShared)).toBe(true)
    expect(sharedGroup(localShared, "")).toBe(true)
    expect(sharedGroup(localShared, "OIPA")).toBe(false)
    expect(sharedGroup(oipaShared, "OIPA")).toBe(true)
    expect(sharedGroup(oipaShared, "")).toBe(false)

    expect(groupTitle("work-mail", undefined, "OIPA")).toContain("OIPA · work-mail")
  })

  test("relayTarget dials explicit non-auto profile directly without automatic scanning", () => {
    const target = relayTarget({}, { id: "oipa", label: "OIPA", address: "127.0.0.1:29980", auto: false, enabled: true })
    expect(target).toEqual({ host: "127.0.0.1", port: 29980, automatic: false })
  })
})

describe("pairingLink #add= support", () => {
  test("parses standard #code= link", () => {
    expect(pairingLink("#code=ABCD-EFGH&port=19990")).toEqual({ code: "ABCD-EFGH", port: 19990 })
  })

  test("parses #add=127.0.0.1:29980&code=ABCD-EFGH&label=OIPA", () => {
    expect(pairingLink("#add=127.0.0.1:29980&code=ABCD-EFGH&label=OIPA")).toEqual({
      code: "ABCD-EFGH",
      port: 29980,
      address: "127.0.0.1:29980",
      label: "OIPA",
      add: true,
    })
  })
})

describe("aggregateRelayState", () => {
  test("combines tabs and reports connected when either local or remote relay is connected", () => {
    const profiles: RelayProfile[] = [
      { id: "local", label: "Mac Local", address: "", auto: true, enabled: true },
      { id: "oipa", label: "OIPA", address: "127.0.0.1:29980", auto: false, enabled: true },
    ]
    const states = new Map<string, AgentRelayState>([
      [
        "local",
        {
          status: "offline",
          pairing: "token",
          tabs: [],
          relay: { address: "localhost:19988", remote: false },
        },
      ],
      [
        "oipa",
        {
          status: "connected",
          pairing: "token",
          tabs: [{ tabId: 42 }],
          relay: { address: "127.0.0.1:29980", remote: false },
          browser: { id: "chrome", name: "Chrome" },
        },
      ],
    ])
    const agg = aggregateRelayState(profiles, states, "oipa")
    expect(agg.status).toBe("connected")
    expect(agg.tabs).toEqual([{ tabId: 42 }])
    expect(agg.relays?.length).toBe(2)
    expect(agg.lendTarget).toBe("oipa")
  })
})

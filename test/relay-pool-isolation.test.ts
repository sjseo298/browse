import { expect, test } from "bun:test"
import { installChrome, settle } from "./chrome-stub"
import { pairingProof } from "../src/background/pairing"
import { LEND_TARGET_ALL } from "../src/shared/protocol"

if (!(globalThis as { chrome?: unknown }).chrome) {
  installChrome()
}
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly made: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: Array<{ method?: string; params?: Record<string, unknown> }> = []
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as { method?: string; params?: Record<string, unknown> })
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: true })
  }
}

const { createRelayPool } = await import("../src/background/relay-pool")

test("pairLink #add= isolates pairing keys and sockets per relay without disturbing local", async () => {
  const prevWebSocket = globalThis.WebSocket
  ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = FakeWebSocket as unknown as typeof WebSocket
  FakeWebSocket.made.length = 0
  const existingKeys = Object.keys(await chrome.storage.local.get(null))
  if (existingKeys.length) await chrome.storage.local.remove(existingKeys)

  let pool: ReturnType<typeof createRelayPool> | undefined
  try {
    pool = createRelayPool({
      changed: () => {},
      badgesChanged: () => {},
    })
    await settle()

    void pool.pairLink("S62W-94ZA", 29980, "127.0.0.1:29980", "oipa")
    await settle()

    const stored = await chrome.storage.local.get(null)
    expect(stored["agentRelayPairingCode:oipa"]).toBe("S62W94ZA")
    expect(stored["agentRelayCodePort:oipa"]).toBe(29980)
    expect(stored["agentRelayPairingCode"]).toBeUndefined()

    // Remote relay dials 127.0.0.1:29980 once with the pairing code hello.
    const oipaSockets = FakeWebSocket.made.filter((ws) => ws.url.includes(":29980"))
    expect(oipaSockets.length).toBe(1)
    expect(oipaSockets[0]!.sent.map((m) => m.method)).toEqual(["protocol", "hello"])
    expect((oipaSockets[0]!.sent[1]?.params?.pairing as { mode?: string } | undefined)?.mode).toBe("code")

    const diag = await pool.diagnostics()
    expect(diag).toContain("relay.configure id=oipa address=127.0.0.1:29980 code=true")
    const localSection = diag.split("=== Relay [oipa]")[0] ?? ""
    expect(localSection).toContain("=== Relay [local]")
    expect(localSection).not.toContain("source=entered")
    expect(localSection).not.toContain("pairing.changed")
    expect(localSection).not.toContain("relay.configure")

    await pool.removeRelay("oipa")
  } finally {
    await pool?.toggleRelay("local", false).catch(() => undefined)
    globalThis.WebSocket = prevWebSocket
  }
})

test("LEND_TARGET_ALL shares lent tabs across connected relays with ref-counted detach and keeps agent tabs exclusive", async () => {
  const prevWebSocket = globalThis.WebSocket
  ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = FakeWebSocket as unknown as typeof WebSocket
  FakeWebSocket.made.length = 0
  const existingKeys = Object.keys(await chrome.storage.local.get(null))
  if (existingKeys.length) await chrome.storage.local.remove(existingKeys)

  const localToken = "local-secret-token-for-test-0001"
  const oipaToken = "oipa-secret-token-for-test-00002"
  await chrome.storage.local.set({
    agentRelayProfiles: [
      { id: "local", label: "Local", address: "", auto: true, enabled: true },
      { id: "oipa", label: "oipa", address: "127.0.0.1:29980", auto: false, enabled: true },
    ],
    agentRelayTokens: {
      "127.0.0.1:19988": localToken,
      "127.0.0.1:29980": oipaToken,
    },
  })

  const origSend = FakeWebSocket.prototype.send
  const authenticate = (ws: FakeWebSocket, token: string, port: number) => {
    const relayNonce = "RelayNonceValueForMultiRelayTest01"
    const orig = ws.send.bind(ws)
    ws.send = (data: string) => {
      orig(data)
      const msg = JSON.parse(data) as { method?: string; id?: number; params?: { pairing?: { nonce?: string } }; error?: { message?: string } }
      if (msg.method === "hello" && msg.params?.pairing?.nonce) {
        void pairingProof(token, "relay", port, relayNonce, msg.params.pairing.nonce).then((proof) => {
          ws.onmessage?.({
            data: JSON.stringify({
              method: "auth.challenge",
              params: { nonce: relayNonce, proof, protocol: { version: 3, min: 3 } },
            }),
          })
        })
      }
    }
  }

  let detachCalls = 0
  const prevDetach = chrome.debugger.detach
  chrome.debugger.detach = (async (target: chrome.debugger.Debuggee) => {
    detachCalls++
    return (prevDetach as ((target: chrome.debugger.Debuggee) => Promise<void>) | undefined)?.(target)
  }) as unknown as typeof chrome.debugger.detach

  let pool: ReturnType<typeof createRelayPool> | undefined
  try {
    pool = createRelayPool({
      changed: () => {},
      badgesChanged: () => {},
    })
    await settle()

    const localWs = FakeWebSocket.made.find((ws) => ws.url.includes(":19988"))!
    const oipaWs = FakeWebSocket.made.find((ws) => ws.url.includes(":29980"))!
    expect(localWs).toBeDefined()
    expect(oipaWs).toBeDefined()

    // Re-trigger hello challenge cleanly by authenticating on both sockets:
    authenticate(localWs, localToken, 19988)
    authenticate(oipaWs, oipaToken, 29980)
    // Reply to the already-sent hello on each socket:
    for (const [ws, token, port] of [
      [localWs, localToken, 19988],
      [oipaWs, oipaToken, 29980],
    ] as const) {
      const hello = ws.sent.find((m) => m.method === "hello") as { params?: { pairing?: { nonce?: string } } } | undefined
      if (hello?.params?.pairing?.nonce) {
        const proof = await pairingProof(token, "relay", port, "RelayNonceValueForMultiRelayTest01", hello.params.pairing.nonce)
        ws.onmessage?.({
          data: JSON.stringify({
            method: "auth.challenge",
            params: { nonce: "RelayNonceValueForMultiRelayTest01", proof, protocol: { version: 3, min: 3 } },
          }),
        })
      }
    }
    await settle()
    expect(pool.state().relays?.every((r) => r.status === "connected")).toBe(true)

    expect(await pool.setLendTarget(LEND_TARGET_ALL)).toBe(true)
    expect(pool.state().lendTarget).toBe(LEND_TARGET_ALL)

    const win = await chrome.windows.create({})
    const tab = await chrome.tabs.create({ windowId: win?.id, url: "https://example.com/" })
    const tabId = tab.id!
    await pool.attachTab(tabId)
    await settle()

    expect(localWs.sent.some((m) => m.method === "toolbar.clicked" && m.params?.tabId === tabId)).toBe(true)
    expect(oipaWs.sent.some((m) => m.method === "toolbar.clicked" && m.params?.tabId === tabId)).toBe(true)

    // Both relays attach to the shared lent tab without conflict.
    localWs.onmessage?.({ data: JSON.stringify({ id: 1, method: "debugger.attach", params: { tabId } }) })
    oipaWs.onmessage?.({ data: JSON.stringify({ id: 2, method: "debugger.attach", params: { tabId } }) })
    await settle()
    expect((localWs.sent.find((m) => (m as { id?: number }).id === 1) as { error?: unknown } | undefined)?.error).toBeUndefined()
    expect((oipaWs.sent.find((m) => (m as { id?: number }).id === 2) as { error?: unknown } | undefined)?.error).toBeUndefined()

    // First relay detaching does NOT drop Chrome's debugger while the second relay still uses it.
    localWs.onmessage?.({ data: JSON.stringify({ id: 3, method: "debugger.detach", params: { tabId } }) })
    await settle()
    expect(detachCalls).toBe(0)

    // Second relay detaching DOES detach Chrome's debugger and clears shared status.
    oipaWs.onmessage?.({ data: JSON.stringify({ id: 4, method: "debugger.detach", params: { tabId } }) })
    await settle()
    expect(detachCalls).toBe(1)

    // Non-shared (agent-exclusive) tab still rejects attachment from another relay.
    const agentTab = await chrome.tabs.create({ windowId: win?.id, url: "https://example.org/" })
    const agentTabId = agentTab.id!
    localWs.onmessage?.({ data: JSON.stringify({ id: 5, method: "debugger.attach", params: { tabId: agentTabId } }) })
    await settle()
    oipaWs.onmessage?.({ data: JSON.stringify({ id: 6, method: "debugger.attach", params: { tabId: agentTabId } }) })
    await settle()
    const conflictReply = oipaWs.sent.find((m) => (m as { id?: number }).id === 6) as { error?: string } | undefined
    expect(conflictReply?.error).toContain("currently in use by relay")
  } finally {
    chrome.debugger.detach = prevDetach
    FakeWebSocket.prototype.send = origSend
    await pool?.toggleRelay("oipa", false).catch(() => undefined)
    await pool?.toggleRelay("local", false).catch(() => undefined)
    globalThis.WebSocket = prevWebSocket
  }
})

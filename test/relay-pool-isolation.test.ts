import { expect, test } from "bun:test"
import { installChrome, settle } from "./chrome-stub"

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

// install's pairing link (welcome.html#code=… or onboarding.html#add=host:port&code=…&label=…):
// a one-time code and, optionally, the relay's port or explicit host:port + label to add as a simultaneous relay.
import { relayPortHint } from "../agent-relay/protocol"
import { relayAddress } from "../shared/protocol"

export type PairingLink = {
  readonly code: string
  readonly port?: number
  readonly address?: string
  readonly label?: string
  readonly add?: boolean
}

/** What a `#code=…&port=…` or `#add=…&code=…&label=…` fragment carries, or undefined when invalid. */
export function pairingLink(hash: string): PairingLink | undefined {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""))
  const code = fragment.get("code")
  if (code === null || !/^[0-9A-Za-z-]{8,9}$/.test(code)) return undefined
  const addParam = fragment.get("add") ?? fragment.get("address")
  const parsedAddress = addParam ? relayAddress(addParam) : undefined
  const address =
    parsedAddress && parsedAddress.host
      ? parsedAddress.port
        ? `${parsedAddress.host}:${parsedAddress.port}`
        : parsedAddress.host
      : undefined
  const port = parsedAddress?.port ?? relayPortHint(Number(fragment.get("port")))
  const rawLabel = fragment.get("label")?.trim().slice(0, 40)
  const label = rawLabel ? rawLabel : undefined
  return {
    code,
    ...(port !== undefined ? { port } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(fragment.has("add") && address !== undefined ? { add: true } : {}),
  }
}

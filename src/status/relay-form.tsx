// The relay address and pairing code form, on both pages: saves them, reconnects, and says how it went.
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Field } from "@opencode/ui/field"
import { TextInput } from "@opencode/ui/text-input"
import { relayResultText, relayResultTone, type RelayResult } from "./describe"
import { Note, Rich, type Relay } from "./ui"

/**
 * The relay address and pairing code form:
 * - `mode="add"`: adds a simultaneous relay (`relay.add`) with an optional label (e.g. "OIPA").
 * - default (`mode="connect"`): updates/pairs the specified `relayId` (or primary relay).
 */
export function RelayForm(props: {
  relay: Relay
  help?: boolean
  remote?: boolean
  mode?: "connect" | "add"
  relayId?: string
  onDone?: () => void
}) {
  const [label, setLabel] = createSignal("")
  const [address, setAddress] = createSignal("")
  const [code, setCode] = createSignal("")
  const [edited, setEdited] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [result, setResult] = createSignal<RelayResult>()

  // In "connect" mode, keep the field synced to the target relay unless the user is editing it.
  createEffect(() => {
    if (props.mode === "add") return
    const state = props.relay.state()
    const target = props.relayId ? state?.relays?.find((r) => r.id === props.relayId) : state
    const relay = target?.relay
    if (relay === undefined || edited()) return
    setAddress(props.remote && !relay.remote ? "" : relay.address)
  })
  // A result doesn't outlive the connection it described.
  createEffect(() => {
    if (props.mode === "add") return
    const state = props.relay.state()
    const target = props.relayId ? state?.relays?.find((r) => r.id === props.relayId) : state
    if (target?.status === "connected" && !pending() && result()?.status !== "connected") setResult(undefined)
  })
  props.relay.onMessage((message) => {
    if (message === undefined) return setPending(false)
    if (message.type !== "relay.result" || !pending()) return
    setPending(false)
    setResult(message)
    if (message.status !== "invalid-code" && message.status !== "invalid-address") {
      setCode("")
      if (props.mode === "add" && message.status === "connected") {
        setLabel("")
        setAddress("")
      }
      props.onDone?.()
    }
  })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (props.mode === "add") {
      const msg = { type: "relay.add" as const, label: label(), address: address(), code: code() }
      setPending(true)
      setResult(undefined)
      props.relay.send(msg)
      return
    }
    // Read what was typed before `edited` flips: the effect above then puts the relay's current address back in the
    // field, which is what the message carried before (a typed address never reached the extension).
    const message = {
      type: "relay.connect" as const,
      ...(props.relayId ? { id: props.relayId } : {}),
      address: address(),
      code: code(),
    }
    setEdited(false)
    setPending(true)
    setResult(undefined)
    props.relay.send(message)
  }

  return (
    <form class="relay-form" onSubmit={submit}>
      <div class="relay-fields">
        <Show when={props.mode === "add"}>
          <Field>
            <Field.Label>Name (optional)</Field.Label>
            <TextInput
              value={label()}
              onInput={(event) => setLabel(event.currentTarget.value)}
              placeholder="OIPA"
              autocomplete="off"
              spellcheck={false}
            />
          </Field>
        </Show>
        <Field>
          <Field.Label>Relay address</Field.Label>
          <TextInput
            value={address()}
            onInput={(event) => {
              setEdited(true)
              setAddress(event.currentTarget.value)
            }}
            placeholder={props.mode === "add" || props.remote ? "127.0.0.1:29980 or 100.64.0.1" : "localhost:19988"}
            autocomplete="off"
            spellcheck={false}
          />
        </Field>
        <Field>
          <Field.Label>Pairing code</Field.Label>
          <TextInput
            value={code()}
            onInput={(event) => setCode(event.currentTarget.value)}
            placeholder="XXXX-XXXX"
            autocomplete="off"
            spellcheck={false}
          />
        </Field>
      </div>
      <Show when={props.help}>
        <p class="hint">
          <Rich text="Over SSH (`ssh -L 127.0.0.1:29980:…:29980`), run `browse install --port 29980` and `browse pair` in the devcontainer, or over Tailscale run `browse set hostname 0.0.0.0` and `browse pair`. Both local and remote relays stay connected together." />
        </p>
      </Show>
      <div class="actions">
        <Button type="submit" variant="contrast" disabled={pending()}>
          {pending() ? "Connecting…" : props.mode === "add" ? "Add & connect" : "Connect"}
        </Button>
      </div>
      <Show when={result()}>
        {(shown) => (
          <Note tone={relayResultTone(shown().status)}>
            <Rich
              text={relayResultText(
                shown().status,
                shown().address ?? "",
                props.relay.state()?.pairing === "code",
              )}
            />
          </Note>
        )}
      </Show>
    </form>
  )
}

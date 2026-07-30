import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  isAnthropicContentBlockStart,
  isAnthropicMessageStart,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { createRecoverySinkSupervisor } from "~/lib/pipeline/generation/recovery-sink-supervisor"

function frame(type: string, extra: Record<string, unknown> = {}): ClientFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) }
}

function messageStart(id: string): ClientFrame {
  return frame("message_start", { message: { id } })
}

function contentBlockStart(index: number): ClientFrame {
  return frame("content_block_start", { index, content_block: { type: "text", text: "" } })
}

function hooks(): AnchorHooks {
  return {
    isMessageStart: isAnthropicMessageStart,
    isContentBlockStart: isAnthropicContentBlockStart,
    startFrame: anchorStartFrame(),
    stopFrame: anchorStopFrame(),
    deltaFrame: anchorDeltaFrame(),
    syntheticMessageStart: syntheticMessageStartFrame,
    remap: remapAnthropicBlockIndex,
  }
}

function anchorState(): AnchorState {
  return {
    injected: false,
    contentAnchorInjected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
}

function recordingSink(): {
  sink: ClientSink
  written: Array<ClientFrame>
  methods: Array<string>
  reset(): void
} {
  const written: Array<ClientFrame> = []
  const methods: Array<string> = []
  const record = (method: string, value: ClientFrame): Promise<void> => {
    methods.push(method)
    written.push(value)
    return Promise.resolve()
  }
  return {
    written,
    methods,
    reset() {
      written.length = 0
      methods.length = 0
    },
    sink: {
      write: (value) => record("write", value),
      writeAnchor: (value) => record("writeAnchor", value),
      writeKeepalive: (value) => record("writeKeepalive", value),
      writeSyntheticEnvelope: (value) => record("writeSyntheticEnvelope", value),
      close: () => methods.push("close"),
      finalize: () => {
        methods.push("finalize")
      },
    },
  }
}

function key(value: ClientFrame): string {
  const payload = JSON.parse(value.data as string) as { type: string; index?: number }
  return typeof payload.index === "number" ? `${payload.type}@${payload.index}` : payload.type
}

function injectEnvelope(sink: ClientSink, state: AnchorState, anchorHooks: AnchorHooks): Promise<void> {
  if (!anchorHooks.syntheticMessageStart) throw new Error("test fixture requires syntheticMessageStart")
  state.injected = true
  state.messageStartForwarded = true
  return (sink.writeSyntheticEnvelope ?? sink.write)(anchorHooks.syntheticMessageStart("claude-test", "req_cross_attempt"))
}

async function injectEmptyTextAnchor(sink: ClientSink, state: AnchorState, anchorHooks: AnchorHooks): Promise<void> {
  await injectEnvelope(sink, state, anchorHooks)
  state.contentAnchorInjected = true
  state.anchorBlockOpen = true
  await (sink.writeAnchor ?? sink.write)(anchorHooks.startFrame)
  await (sink.writeKeepalive ?? sink.write)(anchorHooks.deltaFrame)
}

describe("one persistent live-reconcile sink across attempts", () => {
  test("no hooks: the original sink carries a first-attempt ping and fresh-attempt frames through unchanged", async () => {
    const recording = recordingSink()
    const persistentSink = recording.sink
    const firstAttemptPing = frame("ping")
    const freshMessageStart = messageStart("msg_fresh_no_hooks")
    const freshBlockStart = contentBlockStart(0)

    await persistentSink.write(firstAttemptPing)
    await persistentSink.write(freshMessageStart)
    await persistentSink.write(freshBlockStart)

    expect(recording.written).toEqual([firstAttemptPing, freshMessageStart, freshBlockStart])
    expect(recording.written.map(key)).toEqual(["ping", "message_start", "content_block_start@0"])
  })

  test("hooks exist but no scaffold was injected: both attempts pass through and message_start is recorded", async () => {
    const recording = recordingSink()
    const state = anchorState()
    const persistentSink = makeReconcilingSink(recording.sink, state, hooks())
    const firstAttemptPing = frame("ping")
    const freshMessageStart = messageStart("msg_fresh_uninjected")
    const freshBlockStart = contentBlockStart(0)

    await persistentSink.write(firstAttemptPing)
    await persistentSink.write(freshMessageStart)
    await persistentSink.write(freshBlockStart)

    expect(recording.written).toEqual([firstAttemptPing, freshMessageStart, freshBlockStart])
    expect(recording.written.map(key)).toEqual(["ping", "message_start", "content_block_start@0"])
    expect(state.messageStartForwarded).toBe(true)
  })

  test("injected envelope without an open anchor: fresh duplicate message_start drops and block index stays unchanged", async () => {
    const recording = recordingSink()
    const state = anchorState()
    const anchorHooks = hooks()
    const persistentSink = makeReconcilingSink(recording.sink, state, anchorHooks)

    await injectEnvelope(persistentSink, state, anchorHooks)
    recording.reset()
    const freshBlockStart = contentBlockStart(0)
    await persistentSink.write(messageStart("msg_fresh_enveloped"))
    await persistentSink.write(freshBlockStart)

    expect(recording.written).toEqual([freshBlockStart])
    expect(recording.written.map(key)).toEqual(["content_block_start@0"])
    expect(recording.methods).toEqual(["write"])
    expect(state.anchorClosed).toBe(false)
  })

  test("injected open anchor: supervisor preserves one decorated sink across an attempt boundary", async () => {
    const recording = recordingSink()
    const state = anchorState()
    const anchorHooks = hooks()
    const supervisor = createRecoverySinkSupervisor(recording.sink)
    const persistentSink = makeReconcilingSink(supervisor.sink, state, anchorHooks)

    expect(typeof persistentSink.close).toBe("function")
    expect(typeof persistentSink.finalize).toBe("function")
    await injectEmptyTextAnchor(persistentSink, state, anchorHooks)
    persistentSink.close?.()
    persistentSink.finalize?.()
    expect(recording.methods).not.toContain("close")
    expect(recording.methods).not.toContain("finalize")

    recording.reset()
    await persistentSink.write(messageStart("msg_fresh_empty_text"))
    await persistentSink.write(contentBlockStart(0))

    // Attempt-local close/finalize traversed the outer rewriting decorator but were suppressed by the
    // inner supervisor, so the same decorated sink remains writable for recovery.
    expect(recording.written.map(key)).toEqual(["content_block_stop@0", "content_block_start@1"])
    expect(recording.methods).toEqual(["writeAnchor", "write"])
    expect(state.anchorClosed).toBe(true)

    await supervisor.settleFinal()
    expect(recording.methods).toEqual(["writeAnchor", "write", "close", "finalize"])
  })

  test("injected open anchor: a fresh terminal error closes the anchor exactly once before terminal frames", async () => {
    const recording = recordingSink()
    const state = anchorState()
    const anchorHooks = hooks()
    const persistentSink = makeReconcilingSink(recording.sink, state, anchorHooks)
    const terminalError = frame("error", { error: { type: "api_error", message: "fresh recovery failed" } })

    await injectEmptyTextAnchor(persistentSink, state, anchorHooks)
    recording.reset()
    await persistentSink.write(messageStart("msg_fresh_failed"))
    await persistentSink.write(terminalError)
    await persistentSink.write(frame("message_stop"))

    expect(recording.written.map(key)).toEqual(["content_block_stop@0", "error", "message_stop"])
    expect(recording.methods).toEqual(["writeAnchor", "write", "write"])
    expect(recording.methods.filter((method) => method === "writeAnchor")).toHaveLength(1)
    expect(state.anchorClosed).toBe(true)
  })
})

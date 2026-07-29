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
  closeAnchorIfOpen,
  isAnthropicContentBlockStart,
  isAnthropicMessageStart,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"

import { spliceFreshAttemptFrame } from "../../../src/routes/messages/precontent-recovery-splice"

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

function anchorState(overrides: Partial<AnchorState> = {}): AnchorState {
  return {
    injected: false,
    contentAnchorInjected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
    ...overrides,
  }
}

function recordingSink(): {
  sink: ClientSink
  written: Array<ClientFrame>
  methods: Array<"write" | "writeAnchor" | "writeSynthetic">
} {
  const written: Array<ClientFrame> = []
  const methods: Array<"write" | "writeAnchor" | "writeSynthetic"> = []
  const record = (method: "write" | "writeAnchor" | "writeSynthetic", value: ClientFrame): Promise<void> => {
    methods.push(method)
    written.push(value)
    return Promise.resolve()
  }
  return {
    written,
    methods,
    sink: {
      write: (value) => record("write", value),
      writeAnchor: (value) => record("writeAnchor", value),
      writeSynthetic: (value) => record("writeSynthetic", value),
    },
  }
}

function key(value: ClientFrame): string {
  const payload = JSON.parse(value.data as string) as { type: string; index?: number }
  return typeof payload.index === "number" ? `${payload.type}@${payload.index}` : payload.type
}

describe("spliceFreshAttemptFrame", () => {
  test("ping mode: fresh frames pass through untouched without index remapping", async () => {
    const { sink, written } = recordingSink()
    const state = anchorState()
    const freshMessageStart = messageStart("msg_fresh_ping")
    const freshBlockStart = contentBlockStart(0)

    await spliceFreshAttemptFrame(freshMessageStart, sink, state, undefined)
    await spliceFreshAttemptFrame(freshBlockStart, sink, state, undefined)

    expect(written).toEqual([freshMessageStart, freshBlockStart])
    expect(written[0]).toBe(freshMessageStart)
    expect(written[1]).toBe(freshBlockStart)
    expect(written.map(key)).toEqual(["message_start", "content_block_start@0"])
  })

  test("enveloped_ping mode: duplicate fresh message_start is dropped and real block index is preserved", async () => {
    const { sink, written } = recordingSink()
    const state = anchorState({ injected: true, messageStartForwarded: true })
    const freshBlockStart = contentBlockStart(0)

    await spliceFreshAttemptFrame(messageStart("msg_fresh_enveloped"), sink, state, hooks())
    await spliceFreshAttemptFrame(freshBlockStart, sink, state, hooks())

    expect(written).toEqual([freshBlockStart])
    expect(written[0]).toBe(freshBlockStart)
    expect(written.map(key)).toEqual(["content_block_start@0"])
    expect(state.anchorClosed).toBe(false)
  })

  test("empty_text mode: closes anchor before first real block and shifts real block index by one", async () => {
    const { sink, written } = recordingSink()
    const state = anchorState({
      injected: true,
      contentAnchorInjected: true,
      messageStartForwarded: true,
      anchorBlockOpen: true,
    })

    await spliceFreshAttemptFrame(messageStart("msg_fresh_empty_text"), sink, state, hooks())
    await spliceFreshAttemptFrame(contentBlockStart(0), sink, state, hooks())

    expect(written.map(key)).toEqual(["content_block_stop@0", "content_block_start@1"])
    expect(state.anchorClosed).toBe(true)
  })

  test("empty_text mode: a second dispatch failure before any real block closes anchor before terminal error", async () => {
    const { sink, written, methods } = recordingSink()
    const state = anchorState({
      injected: true,
      contentAnchorInjected: true,
      messageStartForwarded: true,
      anchorBlockOpen: true,
    })
    const terminalError = frame("error", { error: { type: "api_error", message: "fresh recovery failed" } })

    await spliceFreshAttemptFrame(messageStart("msg_fresh_failed"), sink, state, hooks())
    await closeAnchorIfOpen(sink, hooks(), state)
    await sink.writeSynthetic?.(terminalError)

    expect(written.map(key)).toEqual(["content_block_stop@0", "error"])
    expect(methods).toEqual(["writeAnchor", "writeSynthetic"])
    expect(state.anchorClosed).toBe(true)
  })
})

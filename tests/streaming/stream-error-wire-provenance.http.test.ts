/**
 * PRODUCTION-FACING wire provenance for mid-stream lifecycle cancellations.
 *
 * The gap this closes: the deadline/reaper → wire mapping was "landed" as an exhaustive
 * `Record` inside each v4 codec, but `codec.formatError` has NO production caller — every
 * live handler built its terminal error frame inline through its own private mapper. Unit
 * tests that fed a KIND STRING to a formatter were all green while the actual bytes on the
 * wire still said `api_error` / `INTERNAL`.
 *
 * So these drive the real thing: fire `ctx.cancel(request_deadline)` on an in-flight,
 * actively-streaming request and read the client's bytes. Each surface asserts BOTH the
 * value it must now emit AND, negatively, the value it used to emit — a mapper that
 * regresses to a private copy fails here even if every codec table stays correct.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"

import { getRequestContextManager } from "~/lib/context/manager"
import { REQUEST_DEADLINE_CANCEL_REASON } from "~/lib/error/cancellation-reason"
import { getAbortProvenanceGapCounts } from "~/lib/observability/abort-provenance-gaps"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { StreamUnknownCancelError } from "~/lib/stream"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  createSseResponseThenBlock,
  createSseResponseThenError,
} from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"

const app = createFullTestApp()

/** Capture every RequestContext the app creates so the test can cancel the live one. */
function captureContexts(): { contexts: Array<RequestContext>; restore: () => void } {
  const manager = getRequestContextManager()
  const original = manager.create.bind(manager)
  const contexts: Array<RequestContext> = []
  manager.create = (opts) => {
    const ctx = original(opts)
    contexts.push(ctx)
    return ctx
  }
  return { contexts, restore: () => (manager.create = original) }
}

function tick(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `request`, wait until it is actively streaming, then blow its hard deadline the way
 * `context/manager.ts:417` does in production, and return the bytes the client received.
 */
async function cancelMidStreamAndReadWire(request: () => Promise<Response> | Response): Promise<string> {
  const { contexts, restore } = captureContexts()
  try {
    const responsePromise = request()
    const response = await responsePromise
    // The handler has committed and the first upstream frame has flowed; upstream is now
    // blocked, so nothing but the deadline can end this stream.
    await tick()
    const ctx = contexts.at(-1)
    expect(ctx).toBeDefined()
    ctx!.cancel(REQUEST_DEADLINE_CANCEL_REASON)
    return await response.text()
  } finally {
    restore()
  }
}

const CC_FIRST_FRAME = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'
const ANTHROPIC_FIRST_FRAMES = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4.5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
]

describe("mid-stream hard deadline → the wire names a TIMEOUT on every surface", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "test-token", responseHeaderTimeout: 0, streamCommitAfterSec: 0 })
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.5", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
        mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      ],
    })
  })

  test("Anthropic /v1/messages → error.type timeout_error, NOT api_error", async () => {
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenBlock(ANTHROPIC_FIRST_FRAMES))))

    const wire = await cancelMidStreamAndReadWire(() =>
      app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4.5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
    )

    expect(wire).toContain("event: error")
    expect(wire).toContain("timeout_error")
    // The live mapper's default arm before the tables were unified.
    expect(wire).not.toContain("api_error")
    // And it must not borrow the reaper's identity — both ride the SAME lifecycle signal,
    // so only the cause tag can tell them apart.
    expect(wire).not.toMatch(/stale-request reaper/i)
  })

  test("OpenAI /v1/chat/completions → error.type timeout_error, NOT server_error", async () => {
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenBlock([CC_FIRST_FRAME]))))

    const wire = await cancelMidStreamAndReadWire(() =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
    )

    expect(wire).toContain("timeout_error")
    expect(wire).not.toContain("server_error")
  })

  test("Gemini :streamGenerateContent → status DEADLINE_EXCEEDED + code 504, NOT INTERNAL/500", async () => {
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenBlock([CC_FIRST_FRAME]))))

    const wire = await cancelMidStreamAndReadWire(() =>
      app.request("/v1beta/models/gpt-4o:streamGenerateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
    )

    expect(wire).toContain("DEADLINE_EXCEEDED")
    // `code` is derived FROM the status via the canonical gRPC↔HTTP table, so the two fields
    // cannot disagree. The live handler used to hardcode `shutdown ? 503 : 500`, which would
    // have paired DEADLINE_EXCEEDED with 500.
    expect(wire).toContain('"code":504')
    expect(wire).not.toContain("INTERNAL")
    expect(wire).not.toContain('"code":500')
  })
})

/**
 * The OTHER pre-header grid cell, and the one the tests above cannot reach.
 *
 * Anthropic's default path is delayed-commit: we open a 200 SSE stream while the upstream is
 * still silent, so a cancellation can land AFTER we committed but BEFORE upstream response
 * headers arrive. That failure is delivered by `postCommitAbortFrame`, a different builder
 * from the post-header pump — and it used to hardcode `api_error` for every kind. Same hard
 * deadline, two answers, decided by whether upstream headers happened to have arrived.
 *
 * The suite above always has a first frame, so it only ever exercises the post-header cell.
 */
describe("delayed-commit pre-header abort → the same cause gets the same wire type", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      copilotToken: "test-token",
      responseHeaderTimeout: 0,
      // Commit the 200 immediately, then leave upstream silent: the exact production shape.
      streamCommitAfterSec: 0,
      streamKeepalivePingSec: 0,
    })
    setModels({ object: "list", data: [mockModel("claude-sonnet-4.5", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  /** An upstream that never sends response headers — it only settles when its signal aborts. */
  function silentUpstream(): void {
    applyFetchMock(
      mock(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (init as { signal?: AbortSignal } | undefined)?.signal
            const fail = (): void => reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"))
            if (signal?.aborted) return fail()
            signal?.addEventListener("abort", fail, { once: true })
          }),
      ),
    )
  }

  test("hard deadline while upstream is still pre-header → timeout_error, the same as post-header", async () => {
    silentUpstream()

    const wire = await cancelMidStreamAndReadWire(() =>
      app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4.5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
    )

    expect(wire).toContain("event: error")
    expect(wire).toContain("timeout_error")
    // What this builder answered for EVERY kind before it shared the table.
    expect(wire).not.toContain("api_error")
    expect(wire).toContain("hard deadline")
  })
})

/**
 * The gap COUNTER, driven the only way that can prove it: through the real app, so the real driver
 * consumes the real transport's frames.
 *
 * The counter's first home was `dispatch-lifecycle`, on the belief that both transports' frames pass
 * through `ownFrames()`. The Responses upstream-WebSocket leg does not, so that leg produced a
 * deterministic FALSE ZERO — the worst failure for a gap detector, since zero then reads as "no
 * gaps". Its first test suite could not see this because it called `createDispatchLifecycle()` by
 * hand: that only proves "if the funnel is called, the label is right".
 *
 * An untagged lifecycle abort has no production producer any more (that is the whole point), so the
 * upstream body throws the `StreamUnknownCancelError` a skipped-contract producer would have caused.
 * Same object, same driver path, same funnel.
 */
describe("abort-provenance gaps are counted for every real transport", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "test-token", responseHeaderTimeout: 0, streamCommitAfterSec: 0, streamKeepalivePingSec: 0 })
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.5", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
        mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      ],
    })
  })

  test("HTTP transport (Chat Completions) counts its gap under its own surface", async () => {
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenError([CC_FIRST_FRAME], new StreamUnknownCancelError()))))

    await (
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
    ).text()

    expect(getAbortProvenanceGapCounts()).toEqual([{ phase: "post-header", surface: "openai-cc", count: 1 }])
  })

  test("Anthropic counts under its own surface — the label is not shared across legs", async () => {
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenError(ANTHROPIC_FIRST_FRAMES, new StreamUnknownCancelError()))))

    await (
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4.5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
    ).text()

    expect(getAbortProvenanceGapCounts()).toEqual([{ phase: "post-header", surface: "anthropic", count: 1 }])
  })

  test("NEGATIVE: a TAGGED mid-stream cancel on the same path counts nothing", async () => {
    // The metric is only useful if a non-zero reading is an action item. Healthy traffic — a real
    // deadline, which fires the same driver path — must leave it empty.
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenBlock([CC_FIRST_FRAME]))))

    await cancelMidStreamAndReadWire(() =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
    )

    expect(getAbortProvenanceGapCounts()).toEqual([])
  })
})

/**
 * P0-T2 old-runtime oracle for downstream delivery lifecycle.
 *
 * Every case enters through the real /v1/messages HTTP handler and runs the production
 * route → driver → sink path. FakeClock drives delayed commit and heartbeat cadence; only the
 * physical upstream boundary is controlled. Expected SSE is hand-authored, not decoded/rebuilt by
 * production helpers.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { RequestContext } from "~/lib/context/request"

import { getRequestContextManager } from "~/lib/context/manager"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createFullTestApp } from "../helpers/test-app"

const MODEL = "claude-delivery-lifecycle"

// Time here is logical: FakeClock drives commit and heartbeat cadence, so no case ever waits on the
// wall clock and no assertion reads it. The cost is pure CPU — assembling the real app, running the
// full route → driver → sink path, and two 120-step microtask drains — which is exactly what CPU
// starvation eats. Under the 16-shard runner (`scripts/parallel-test.ts`) that pushed the 418 case
// past the 5s default; measured under deliberate contention it stays "slower but completes" (8.2s at
// 48 spinners, 7.1s at 64) rather than wedging, while tightening to `--timeout 1000` in isolation
// still passes. Budget the file for that instead of weakening the byte-exact wire oracles. 30s
// clears both 10x the isolated worst case and 3x the worst observed under sharding.
setDefaultTimeout(30_000)

type FetchMode = "http-418" | "client-abort"

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function normalizedWire(wire: string): string {
  return wire.replaceAll(/"id":"msg_synthetic_[^"]+"/g, '"id":"msg_synthetic_N"')
}

function syntheticScaffoldWire(): string {
  return [
    sse("ping", { type: "ping" }),
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_synthetic_N",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
  ].join("")
}

function canonicalClientNodes(record: ModelOperationRecord): Array<{ handle: string; sequence: number; value: unknown; detail?: string }> {
  const nodes = new Map(record.arena.frames.map((node) => [node.handle, node]))
  return (record.egress?.client.frames ?? []).map((handle) => {
    const node = nodes.get(handle)
    if (!node) throw new Error(`missing client frame node ${handle}`)
    return { handle, sequence: node.sequence, value: node.value, ...(node.origin.detail && { detail: node.origin.detail }) }
  })
}

describe("P0-T2 downstream delivery lifecycle live-handler baseline", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let mode: FetchMode
  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>
  let capturedCtx: RequestContext | undefined

  const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL: ${url}`)
    gateReached()
    if (mode === "http-418") {
      return gateOpenP.then(
        () =>
          new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "mock 418" } }), {
            status: 418,
            headers: { "content-type": "application/json" },
          }),
      )
    }
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"))
      if (init?.signal?.aborted) rejectAbort()
      else init?.signal?.addEventListener("abort", rejectAbort, { once: true })
    })
  })

  beforeEach(() => {
    clock.install()
    mode = "http-418"
    gateReachedP = new Promise<void>((resolve) => (gateReached = resolve))
    gateOpenP = new Promise<void>((resolve) => (openGate = resolve))
    capturedCtx = undefined
    fetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2,
      streamCommitAfterSec: 2,
      streamKeepaliveMode: "empty_text",
      protectStreamingGeneration: false,
    })
    applyFetchMock(fetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
    const manager = getRequestContextManager()
    const create = manager.create.bind(manager)
    manager.create = (opts) => (capturedCtx = create(opts))
  })

  afterEach(() => clock.restore())

  async function openCommittedStream(signal?: AbortSignal): Promise<{ textP: Promise<string> }> {
    const resP = createFullTestApp().request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": `delivery-${mode}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "wait" }], max_tokens: 64, stream: true }),
      ...(signal && { signal }),
    })
    await gateReachedP
    await clock.advance(2_000)
    await drain()
    const res = await resP
    expect(res.status).toBe(200)
    const textP = res.text()
    await clock.advance(2_500)
    await drain()
    return { textP }
  }

  test("nonretryable post-commit HTTP 418 balances scaffold close → terminal, then fake time cannot append heartbeat", async () => {
    mode = "http-418"
    const { textP } = await openCommittedStream()
    openGate()
    const wire = normalizedWire(await textP)
    const expected =
      syntheticScaffoldWire()
      + sse("content_block_stop", { type: "content_block_stop", index: 0 })
      + sse("error", {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Failed to create messages",
        },
      })
    expect(wire).toBe(expected)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const terminalRecord = capturedCtx?.modelOperationTerminalRecord
    if (!terminalRecord?.terminal) throw new Error("missing canonical terminal record")
    const before = canonicalClientNodes(terminalRecord)
    expect(before.map(({ detail }) => detail).filter(Boolean)).toEqual(["keepalive", "synthetic-message-start", "anchor", "keepalive", "anchor", "synthetic"])
    expect(before.every(({ sequence }) => sequence < terminalRecord.terminal!.sequence)).toBe(true)
    await clock.advance(0)
    await drain()
    expect(clock.liveTimerDelaysMs.every((delay) => delay > 2_000)).toBe(true)

    await clock.advance(20_000)
    expect(clock.liveTimerDelaysMs.every((delay) => delay > 2_000)).toBe(true)
    expect(canonicalClientNodes(capturedCtx!.modelOperationTerminalRecord!)).toEqual(before)
  })

  test("client abort after scaffold writes no close/error/message terminal bytes and stops heartbeat", async () => {
    mode = "client-abort"
    const clientAbort = new AbortController()
    const { textP } = await openCommittedStream(clientAbort.signal)
    clientAbort.abort()
    const wire = normalizedWire(await textP)

    // The client had already received the synthetic scaffold. Client abort must append NOTHING:
    // no content_block_stop, no event:error, no message_delta/message_stop.
    expect(wire).toBe(syntheticScaffoldWire())
    const terminalRecord = capturedCtx?.modelOperationTerminalRecord
    expect(terminalRecord?.terminal?.outcome).toBe("aborted")
    expect(
      canonicalClientNodes(terminalRecord!)
        .map(({ detail }) => detail)
        .filter(Boolean),
    ).toEqual(["keepalive", "synthetic-message-start", "anchor", "keepalive"])
    await clock.advance(0)
    await drain()
    expect(clock.liveTimerDelaysMs.every((delay) => delay > 2_000)).toBe(true)
    await clock.advance(20_000)
    expect(clock.liveTimerDelaysMs.every((delay) => delay > 2_000)).toBe(true)
  })
})

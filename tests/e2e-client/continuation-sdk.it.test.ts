/**
 * client↔proxy SDK e2e — continuation-retry (spec 2026-07-22 §4-§5, ADR D3). The DEFINITIVE proof that
 * the handler wiring is LIVE end-to-end: a real `@anthropic-ai/sdk` client drives the FULL proxy
 * (`serveInProcess`), the upstream is shielded and SCRIPTED to cut mid-stream after a committed block,
 * and the proxy runs a synthetic continuation exchange whose frames stitch onto the SAME client stream.
 * The SDK's `.finalMessage()` is the oracle: it must accumulate the delivered prefix + the continuation
 * blocks as ONE coherent turn (single message_start, contiguous indices, no throw, no corruption).
 *
 * This is the production-path counterpart of exp/continuation-stitch (which fed the SDK hand-built frames):
 * here the STITCH is produced by the real driver+handler, so it proves both the wiring AND the wire shape.
 */

import Anthropic from "@anthropic-ai/sdk"
import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import {
  //
  drainV3Writer,
  getV3Operation,
} from "~/lib/history/v3/store"
import { drainModelOperationTerminalSubscribers } from "~/lib/history/v3/terminal-bus"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { waitUntil } from "../helpers/wait-until"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"
import {
  //
  createSseResponse,
  scriptedUpstream,
  sequencedUpstream,
} from "./harness/upstream-script"

const MODEL = "claude-opus-4"

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}
const textBlock = (index: number, text: string): Array<string> => [
  frame("content_block_start", { index, content_block: { type: "text", text: "" } }),
  frame("content_block_delta", { index, delta: { type: "text_delta", text } }),
  frame("content_block_stop", { index }),
]
const thinkingBlock = (index: number, thinking: string): Array<string> => [
  frame("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }),
  frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking } }),
  frame("content_block_delta", { index, delta: { type: "signature_delta", signature: "sig_e2e" } }),
  frame("content_block_stop", { index }),
]
const msgStart = (id: string): string =>
  frame("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  })
const terminal: Array<string> = [
  frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }),
  frame("message_stop", {}),
]

describe("client↔proxy SDK e2e — continuation-retry (upstream shielded)", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  let client: Anthropic

  beforeAll(() => {
    proxy = serveInProcess()
    client = new Anthropic({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
    })
    // Block-level buffering ON so the committed-block path (and thus continuation) is active; continuation
    // defaults ON (D4). The upstream is scripted, so no billing.
    setStateForTests({ protectStreamingGeneration: "on", bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 } })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  const streamFinal = (sessionId: string, message: string) =>
    client.messages
      .stream({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: message }] }, { headers: { "x-session-id": sessionId } })
      .finalMessage()
  const entryForSession = (sessionId: string) => getHistory({ endpoint: "anthropic-messages", sessionId }).entries[0]

  test("CHAINED persistence oracle: primary plus two continuation legs keep exact provenance", async () => {
    // exchange 1: message_start + text@0, then CLEAN CLOSE without message_stop = truncation after a commit.
    // exchange 2 (continuation): its own message_start + text@0, then another cut.
    // exchange 3 (continuation): its own message_start + text@0 + terminal.
    const up = sequencedUpstream([
      () => createSseResponse([msgStart("msg_1"), ...textBlock(0, "First half. ")]),
      () => createSseResponse([msgStart("msg_2_dup"), ...textBlock(0, "Middle. ")]),
      () => createSseResponse([msgStart("msg_3_dup"), ...textBlock(0, "Second half."), ...terminal]),
    ])
    setUpstreamFetchForTests(up.handler)

    const sessionId = "continuation-sdk-single"
    const final = await streamFinal(sessionId, "write")

    expect(up.callCount()).toBe(3) // two continuation exchanges were dispatched
    // ONE coherent turn across all three legs, with no throw or corruption.
    expect(final.content).toEqual([
      { type: "text", text: "First half. " },
      { type: "text", text: "Middle. " },
      { type: "text", text: "Second half." },
    ] as never)
    expect(final.stop_reason).toBe("end_turn")
    expect(up.requestBodies()).toHaveLength(3)
    for (const body of up.requestBodies()) expect(body).not.toHaveProperty("synthetic")

    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()
    await waitUntil(
      () => {
        const persisted = entryForSession(sessionId)
        return persisted !== undefined && getV3Operation(persisted.id) !== undefined
      },
      { label: "persisted continuation canonical operation" },
    )
    const entry = entryForSession(sessionId)
    const canonical = entry ? getV3Operation(entry.id) : undefined
    expect(canonical?.dispatches.map((dispatch) => dispatch.upstreamRequest?.synthetic)).toEqual([undefined, "continuation", "continuation"])
    expect(entry?.attempts?.map((attempt) => attempt.upstreamRequest?.synthetic)).toEqual([undefined, "continuation", "continuation"])
    expect(entry?.attempts?.[1]?.upstreamRequest?.messages).toEqual([
      { role: "user", content: "write" },
      { role: "assistant", content: [{ type: "text", text: "First half. " }] },
      { role: "user", content: "network issue. please continue" },
    ])
    expect(entry?.attempts?.[2]?.upstreamRequest?.messages).toEqual([
      { role: "user", content: "write" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First half. " },
          { type: "text", text: "Middle. " },
        ],
      },
      { role: "user", content: "network issue. please continue" },
    ])
    for (const attempt of entry?.attempts ?? []) {
      expect(attempt.upstreamResponse).not.toHaveProperty("synthetic")
      expect(attempt.upstreamResponse?.sseEvents?.some((event) => event.synthetic !== undefined)).toBe(false)
    }
  })

  test("C3 through the real path: a delivered thinking block does not shift the continuation index (wire count, not ledger)", async () => {
    // exchange 1: thinking@0 + text@1 committed (wire count 2; ledger holds only text), then cut.
    // exchange 2: text@0 continuation → must land at wire index 2, NOT 1 (which would collide/corrupt).
    const up = sequencedUpstream([
      () => createSseResponse([msgStart("msg_t"), ...thinkingBlock(0, "reason"), ...textBlock(1, "Answer 1. ")]),
      () => createSseResponse([msgStart("msg_t2"), ...textBlock(0, "Answer 2."), ...terminal]),
    ])
    setUpstreamFetchForTests(up.handler)

    const sessionId = "continuation-sdk-thinking"
    const final = await streamFinal(sessionId, "think then write")

    expect(up.callCount()).toBe(2)
    // thinking delivered + two text blocks stitched contiguously — the continuation text is its OWN block
    // (not merged into "Answer 1."), proving the offset used the wire count (2), not the ledger length (1).
    expect(final.content).toEqual([
      { type: "thinking", thinking: "reason", signature: "sig_e2e" },
      { type: "text", text: "Answer 1. " },
      { type: "text", text: "Answer 2." },
    ] as never)
    expect(final.stop_reason).toBe("end_turn")
  })

  test("positive control: a clean single-exchange turn is untouched (continuation never fires)", async () => {
    const up = scriptedUpstream(() => createSseResponse([msgStart("msg_ok"), ...textBlock(0, "All in one. "), ...terminal]))
    setUpstreamFetchForTests(up.handler)

    const sessionId = "continuation-sdk-clean"
    const final = await streamFinal(sessionId, "hi")

    expect(up.callCount()).toBe(1) // no continuation dispatched
    expect(final.content).toEqual([{ type: "text", text: "All in one. " }] as never)

    await waitUntil(() => entryForSession(sessionId) !== undefined, { label: "clean transient history entry" })
    const entry = entryForSession(sessionId)
    expect(entry?.attempts).toHaveLength(1)
    expect(entry?.attempts?.[0]?.upstreamRequest).not.toHaveProperty("synthetic")
  })
})

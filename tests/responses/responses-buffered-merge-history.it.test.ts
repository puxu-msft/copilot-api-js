/**
 * Task 5.2 — Responses buffered-merge HTTP block-level flush + History dual-track golden test.
 *
 * Drives the REAL /responses HTTP path (createFullTestApp → handler-v4 → driver.runResponseBufferedSink
 * → candidate-hosted reducer) with `responsesBufferedRetry` ON + default drop-delta/repair-if-incomplete.
 * Asserts the two-track History contract (spec §6):
 *   1. clean complete → forwarded track omits mid-block deltas, upstream track keeps every delta, no
 *      synthetic tag (the upstream terminal was already complete → repair is a no-op).
 *   2. defective complete (empty output) → forwarded terminal is REBUILT from the collected output_item.done
 *      + tagged synthetic "buffered-terminal-repair"; the upstream track keeps the defective original.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { finalUpstreamResponse } from "~/lib/history/entry-view"
import { getHistory } from "~/lib/history/store"
import {
  //
  setDisabledModels,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenError,
} from "../helpers/sse"
import { functionCallBlock } from "./fixtures/buffered-merge-blocks"

const MODEL = "gpt-5"

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

/** created → the function_call block fixture → response.completed carrying `completedOutput`. */
function generationSse(completedOutput: Array<unknown>): Array<string> {
  const { frames } = functionCallBlock(0, "fc_1")
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_1", object: "response", status: "in_progress", model: MODEL, output: [] } })}\n\n`,
    ...frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`),
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 99, response: { id: "resp_1", object: "response", status: "completed", model: MODEL, output: completedOutput, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`,
  ]
}

let currentSse: Array<string> = []
const upstreamFetchMock = mock(() => Promise.resolve(createSseResponse(currentSse)))

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(): Promise<Response> {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  return app.request("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "hi", stream: true }),
  })
}

describe("Responses buffered-merge: HTTP block-level flush + History dual-track", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      upstreamWebSocket: false,
      responsesBufferedRetry: true,
      responsesBufferedMergeEventCompaction: "drop-delta",
      responsesBufferedMergeCompletedOutput: "repair-if-incomplete",
    })
    applyFetchMock(upstreamFetchMock)
  })

  test("forwarded track omits function_call_arguments.delta; upstream track keeps both deltas; no synthetic tag (completed was already complete)", async () => {
    const { finalItem } = functionCallBlock(0, "fc_1")
    currentSse = generationSse([finalItem])
    await (await streamRequest()).text()

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    const upstreamDeltaCount = finalUpstreamResponse(entry)!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length
    const forwardedDeltaCount = entry.clientResponse!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length
    expect(upstreamDeltaCount).toBe(2)
    expect(forwardedDeltaCount).toBe(0)
    expect(entry.clientResponse!.sseEvents!.some((e) => e.synthetic === "buffered-terminal-repair")).toBe(false)
  })

  test("defective upstream completed (empty output) is repaired on the forwarded track + tagged synthetic; upstream track keeps the defective original", async () => {
    const { finalItem } = functionCallBlock(0, "fc_1")
    currentSse = generationSse([]) // defective: empty output despite a collected output_item.done
    await (await streamRequest()).text()

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    const upstreamCompleted = finalUpstreamResponse(entry)!.sseEvents!.find((e) => e.type === "response.completed")
    const forwardedCompleted = entry.clientResponse!.sseEvents!.find((e) => e.type === "response.completed")
    expect(JSON.parse(upstreamCompleted!.raw).response.output).toEqual([]) // upstream track keeps the defective original
    expect(JSON.parse(forwardedCompleted!.raw).response.output).toEqual([finalItem]) // forwarded track is repaired
    expect(forwardedCompleted!.synthetic).toBe("buffered-terminal-repair")
  })

  test("retry-reset: attempt 1's pre-commit RST is discarded, attempt 2 recovers cleanly, drop-delta still applies + no attempt-1 leak", async () => {
    // attempt 1: created + added + a partial delta (NO output_item.done → no commit) then RST → retryable.
    const attempt1 = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_a1", object: "response", status: "in_progress", model: MODEL, output: [] } })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_fc_1", name: "get_weather", arguments: "", status: "in_progress" } })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", sequence_number: 2, output_index: 0, item_id: "fc_1", delta: "LEAK_ATTEMPT1" })}\n\n`,
    ]
    const { finalItem } = functionCallBlock(0, "fc_1")
    let call = 0
    applyFetchMock(
      mock(() => {
        call++
        return Promise.resolve(call === 1 ? createSseResponseThenError(attempt1, RST_ERROR) : createSseResponse(generationSse([finalItem])))
      }),
    )

    const sse = await (await streamRequest()).text()
    expect(sse).not.toContain("LEAK_ATTEMPT1") // attempt-1 partial never reaches the client
    expect(sse).toContain("response.completed")
    expect(call).toBe(2) // one RST + one recovery

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // drop-delta still applied to the recovered attempt 2 (fresh candidate → fresh reducer), no leak.
    expect(entry.clientResponse!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length).toBe(0)
    const forwardedCompleted = entry.clientResponse!.sseEvents!.find((e) => e.type === "response.completed")
    expect(JSON.parse(forwardedCompleted!.raw).response.output).toEqual([finalItem])
  })

  test("partial-degrade: a block committed live at its output_item.done stays merged; the later un-terminated RST degrades to failed (not retried)", async () => {
    // The block commits at output_item.done (a commit boundary) → committedAny closes the retry window;
    // the subsequent RST (no response.completed) is un-retryable → partial-degrade → history `failed`.
    const { frames } = functionCallBlock(0, "fc_1")
    const committedThenRst = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_pd", object: "response", status: "in_progress", model: MODEL, output: [] } })}\n\n`,
      ...frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`),
    ]
    let call = 0
    applyFetchMock(
      mock(() => {
        call++
        return Promise.resolve(createSseResponseThenError(committedThenRst, RST_ERROR))
      }),
    )

    await (await streamRequest()).text()
    expect(call).toBe(1) // committed prefix is un-retryable → no re-exchange

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    // The committed block's deltas were still merged away (item closed by output_item.done before flush).
    expect(entry.clientResponse!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length).toBe(0)
    expect(entry.clientResponse!.sseEvents!.some((e) => e.type === "response.output_item.done")).toBe(true)
  })
})

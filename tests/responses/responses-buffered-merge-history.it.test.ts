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
import { createSseResponse } from "../helpers/sse"
import { functionCallBlock } from "./fixtures/buffered-merge-blocks"

const MODEL = "gpt-5"

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
})

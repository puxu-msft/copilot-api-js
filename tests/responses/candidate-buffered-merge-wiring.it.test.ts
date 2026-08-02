/**
 * Task 2.10 — candidate-hosted buffered-merge reducer wiring (spec §4 2026-07-19 重接地).
 *
 * The candidate-hosted `transformBufferedFlush` seam ONLY activates when a generation runtime binds a
 * candidate session to the upstream — which only the full driver path (createFullTestApp → handler-v4
 * → driver.runResponseBufferedSink) establishes. A bare `runResponseBufferedSink(deps, ...)` unit call
 * has no binding, so `currentCandidateResponseOpts(undefined, ...)` returns just the outer opts and the
 * reducer never runs. Hence this is an HTTP end-to-end wiring test (the honest vehicle), not a
 * bare-driver harness. Asserts the DEFAULT drop-delta reducer (Task 2.10's hardcoded literal) actually
 * filters the Responses candidate's flushed frames on the forwarded wire the client receives.
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
import { setModels } from "~/lib/models/cache"
import {
  //
  setDisabledModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { functionCallBlock } from "./fixtures/buffered-merge-blocks"

const MODEL = "gpt-5"

/** A clean function_call generation: created → the block fixture (added/delta×2/done/output_item.done)
 *  → response.completed carrying the complete finalItem (so completed_output stays a no-op — no repair). */
function functionCallGenerationSse(): Array<string> {
  const { frames, finalItem } = functionCallBlock(0, "fc_1")
  const created = {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp_fc", object: "response", status: "in_progress", model: MODEL, output: [] },
  }
  const completed = {
    type: "response.completed",
    sequence_number: 99,
    response: { id: "resp_fc", object: "response", status: "completed", model: MODEL, output: [finalItem], usage: { input_tokens: 10, output_tokens: 5 } },
  }
  return [
    `event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
    ...frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`),
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
  ]
}

const upstreamFetchMock = mock(() => Promise.resolve(createSseResponse(functionCallGenerationSse())))

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

describe("candidate-hosted reducer wiring (Task 2.10)", () => {
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
    })
    applyFetchMock(upstreamFetchMock)
  })

  test("the default drop-delta reducer filters function_call_arguments.delta off the forwarded wire, keeps .done + the terminal", async () => {
    const sse = await (await streamRequest()).text()

    // The forwarded wire the client receives: mid-block deltas are dropped (item was closed), while the
    // absolute-value .done + the terminal survive — proving the candidate-hosted reducer actually ran.
    expect(sse).not.toContain("response.function_call_arguments.delta")
    expect(sse).toContain("response.function_call_arguments.done")
    expect(sse).toContain("response.completed")
  })

  test("Task 3.4: dual-track history — upstream keeps every delta, forwarded omits them, pipelineInfo.bufferedMerge recorded", async () => {
    await (await streamRequest()).text()

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // Upstream-original track keeps the raw generation verbatim (richest-data-flow): both deltas survive.
    const upstreamDeltas = finalUpstreamResponse(entry)!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta")
    expect(upstreamDeltas.length).toBe(2)
    // Forwarded track (what the client received) has the deltas dropped by the default drop-delta reducer.
    const forwardedDeltas = entry.clientResponse!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta")
    expect(forwardedDeltas.length).toBe(0)
    // A clean complete generation needs no repair, so no synthetic terminal-repair tag on the forwarded track.
    expect(entry.clientResponse!.sseEvents!.some((e) => e.synthetic === "buffered-terminal-repair")).toBe(false)
    // The merge diagnostics reached history via recordBufferedMergeInfo() → mergedPipelineInfo() (Task 3.3).
    expect(entry?.pipelineInfo?.bufferedMerge?.eventCompaction).toBe("drop-delta")
    expect(entry?.pipelineInfo?.bufferedMerge?.completedOutput).toBe("repair-if-incomplete")
    expect(entry?.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(2)
  })
})

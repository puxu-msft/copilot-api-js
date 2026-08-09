/**
 * I9 probe (Task 37 seam re-review, viewpoint A) — does the outer Anthropic `commitBoundaries`
 * predicate (which treats a raw upstream `event:error` frame as BOTH a commit boundary and the
 * response terminus) actually get exercised through the real driver + generation-runtime binding
 * on the L2 buffered path, or does `mergeCandidateResponseOpts`'s `{ ...outer, ...candidate }`
 * silently replace it with the candidate's own `commitBoundaries` (which only recognizes a
 * unit-close, never a `protocol-error`-classified frame)?
 *
 * This drives the REAL HTTP entry point (`createFullTestApp` → handler-v4 → driver) with
 * `protect_streaming_generation=on`, so `runResponseBufferedSink` sees the SAME
 * `unhedgedBinding`/`currentCandidateResponseOpts` path production traffic takes.
 */
import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import {
  //
  messageStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "claude-sonnet-4.6"

/** message_start, then a raw non-canonical upstream `event:error` frame, then a clean drain — NO message_stop. This is the H2 shape: a terminal upstream DECISION (not a transport RST). */
function buildH2Frames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_h2probe", model }),
    "event: error\ndata: " + JSON.stringify({ error: { type: "overloaded_error", message: "upstream overloaded" } }) + "\n\n",
  ]
}

let upstreamCalls = 0
const upstreamFetchMock = mock((url: string) => {
  if (url.includes("/chat/completions") || url.includes("/responses")) throw new Error("unexpected non-Anthropic upstream call")
  upstreamCalls++
  return Promise.resolve(createSseResponse(buildH2Frames(MODEL)))
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("I9 probe — H2 (raw upstream event:error) on the L2 buffered path", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    upstreamCalls = 0
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      staleRequestMaxAge: 0,
      streamKeepalivePingSec: 0,
      protectStreamingGeneration: "on",
      bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      bufferedRetryContinuationShared: { enabled: false, message: "network issue. please continue" },
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("a raw event:error frame (no message_stop) commits + surfaces the error — NOT retried as a truncation", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "i9-probe-h2" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    const types = frameTypesInOrder(sse)

    // The KEY discriminator for I9/D2: if the outer commitBoundaries is silently shadowed by the candidate's own (which never recognizes a protocol-error frame as a unit-close), the driver will NOT commit in-loop on the error frame and will instead retry (consuming the same mocked upstream again) or misclassify the outcome. If commitBoundaries correctly fires, exactly ONE upstream call happens and the client receives the error frame (not a silent drop/retry loop).
    expect(types).toContain("error")
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "i9-probe-h2", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
  })
})

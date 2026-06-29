/**
 * Immediate client-proxy keepalive (no grace race): streaming /v1/messages opens 200 on
 * request receipt and runs a connection-level heartbeat decoupled from the upstream.
 *   1. a complete stream:true generation with ping=0 → EXACT forwarded SSE bytes (no ping).
 *   2. a pre-response upstream HTTPError → 200 SSE stream + rich error frame (status already 200).
 *   3. a stalled upstream + cadence ping → ping precedes content / degrades 401 to an SSE frame.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  dataFramesOfType,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "claude-opus-4.8"

/** A clean text generation with the terminal sequence (no decode/filter trigger). */
function buildCompleteFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_grace", model }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "Thinking done."),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "end_turn", outputTokens: 12 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

/** A canonical Anthropic error body for a pre-response HTTPError (no stream opened). */
function errorBody(status: number): string {
  const type =
    status === 429 ? "rate_limit_error"
    : status === 401 ? "authentication_error"
    : status === 400 ? "invalid_request_error"
    : "api_error"
  return JSON.stringify({ type: "error", error: { type, message: `mock ${status}` } })
}

type Mode = { kind: "complete" } | { kind: "http-error"; status: number }
let mode: Mode = { kind: "complete" }

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL
  if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
  if (mode.kind === "http-error") {
    return Promise.resolve(new Response(errorBody(mode.status), { status: mode.status, headers: { "content-type": "application/json" } }))
  }
  return Promise.resolve(createSseResponse(buildCompleteFrames(model)))
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(sessionId: string): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
  })
}

describe("immediate-keepalive — complete + pre-response error", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    mode = { kind: "complete" }
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      streamIdleTimeout: 0,
      // No synthetic heartbeat → the forwarded byte stream is fully deterministic.
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 0, // commit immediately → pre-response errors degrade to 200 SSE frames
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("complete stream → forwarded bytes are byte-identical to upstream frames (minus [DONE])", async () => {
    const res = await streamRequest("grace-c3a-complete")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()

    // Literal byte lock: the pump forwards the upstream frames verbatim (identity S5 rewrites
    // for a clean text+terminal generation), dropping the trailing `data: [DONE]` (the pump
    // breaks on [DONE]). C1 sink-injection + C3b ③ (grace disabled / PRE-COMMIT) MUST keep this.
    expect(text).toBe(buildCompleteFrames(MODEL).slice(0, -1).join(""))

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "grace-c3a-complete", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })

  for (const status of [400, 401] as const) {
    test(`pre-response upstream ${status} → 200 SSE stream + rich error frame (immediate-keepalive)`, async () => {
      mode = { kind: "http-error", status }
      const res = await streamRequest(`grace-c3a-${status}`)

      // New behavior: streaming opens 200 on request receipt (immediate keepalive), runRequest runs
      // inside the stream. A pre-response upstream HTTPError degrades to a rich SSE error frame on the
      // already-200 stream — the canonical error.type is preserved so the client SDK still branches.
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const text = await res.text()
      const types = frameTypesInOrder(text)
      expect(types).toContain("error")

      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: `grace-c3a-${status}`, limit: 5 }).entries[0]
      expect(entry?.state).toBe("failed")
    })
  }
})

describe("immediate-keepalive — stall cadence ping", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>
  let commitMode: "complete" | "error-401" = "complete"

  // A gated upstream that signals when the fetch is reached, then WITHHOLDS its Response until the
  // test opens the gate — modelling the pre-response silence the grace window races against.
  const gatedFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
    gateReached()
    return gateOpenP.then(() =>
      commitMode === "error-401" ?
        new Response(errorBody(401), { status: 401, headers: { "content-type": "application/json" } })
      : createSseResponse(buildCompleteFrames(payload.model ?? MODEL)),
    )
  })

  beforeEach(() => {
    clock.install()
    gatedFetchMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    commitMode = "complete"
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2,
      streamCommitAfterSec: 2, // window fires at 2s → commit 200; heartbeat then pings every 2s
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("upstream stalls → cadence ping precedes content, then completes → content forwarded after the ping", async () => {
    const resP = streamRequest("grace-commit-complete")
    await gateReachedP // upstream fetch reached, stream already 200, heartbeat armed
    await clock.advance(5_000) // cadence elapses with no real frame → forced keepalive ping
    const res = await resP
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    openGate() // upstream returns → pump forwards the content on the SAME sink
    const text = await res.text()
    const types = frameTypesInOrder(text)
    expect(types[0]).toBe("ping") // the cadence ping precedes all real content (keepalive during stall)
    expect(types).toContain("message_start")
    expect(types).toContain("message_stop")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "grace-commit-complete", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })

  test("cold-start commit emits an IMMEDIATE first ping (not waiting a full cadence)", async () => {
    // commit window 2s, but cadence 30s. The immediate cold-start ping must fire AT commit, long
    // before the 30s cadence — proving the fast-failure/margin ping is independent of cadence.
    setStateForTests({ streamCommitAfterSec: 2, streamKeepalivePingSec: 30 })
    const resP = streamRequest("grace-commit-immediate")
    await gateReachedP
    await clock.advance(2_000) // window fires → commit + immediate ping (cadence 30s NOT reached)
    const res = await resP
    openGate()
    const types = frameTypesInOrder(await res.text())
    expect(types[0]).toBe("ping") // immediate ping present despite cadence 30s ≫ elapsed
    expect(types).toContain("message_stop")
  })

  test("upstream stalls → cadence ping, then upstream 401 → rich SSE error frame (HTTP status stays 200)", async () => {
    commitMode = "error-401"
    const resP = streamRequest("grace-commit-401")
    await gateReachedP
    await clock.advance(5_000) // cadence ping during the stall
    const res = await resP
    expect(res.status).toBe(200) // already committed — HTTP status locked at 200, the error degrades to an SSE frame

    openGate() // upstream rejects (401) → POST-COMMIT (c) branch → rich error frame on the same sink
    const text = await res.text()
    const types = frameTypesInOrder(text)
    expect(types[0]).toBe("ping")
    expect(types).toContain("error")
    // Q2 make-or-break: the rich frame preserves the canonical error.type the client SDK branches on.
    expect((dataFramesOfType(text, "error")[0]?.error as { type?: string } | undefined)?.type).toBe("authentication_error")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "grace-commit-401", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    // richest-data-flow (L-2): the first ping the client genuinely received is persisted to history
    // even on a POST-COMMIT FAILURE entry (the COMMIT finally snapshots forwardedSseEvents).
    const forwardedTypes = (entry?.inboundResponse?.sseEvents ?? []).map((e) => {
      try {
        return (JSON.parse(e.raw) as { type?: string }).type
      } catch {
        return undefined
      }
    })
    expect(forwardedTypes).toContain("ping")
  })
})

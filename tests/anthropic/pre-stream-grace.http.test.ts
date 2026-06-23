/**
 * ③ pre-response delayed-commit (pre_stream_grace) — golden pre-capture + behavior.
 *
 * C3a (this commit): lock the CURRENT (pre-③) live-streaming behavior BEFORE the
 * delayed-commit lands, so the byte-equivalence invariants are guarded through the
 * C1 sink-injection refactor and the C3b ③ body:
 *   1. a complete stream:true generation → EXACT forwarded SSE bytes (literal lock).
 *      ③ with grace disabled (or grace>0 + a fast upstream = PRE-COMMIT) MUST stay
 *      byte-identical to this.
 *   2. a pre-response upstream HTTPError (before any response header) → the proxy
 *      emits the real HTTP status (forwardError). This is the PRE-COMMIT baseline:
 *      ③ with grace>0 + a fast-erroring upstream MUST still produce the same HTTP
 *      status (zero divergence); only a stall PAST the grace window downgrades to a
 *      200 + rich SSE error frame (added in C3b).
 *
 * The grace-race + COMMIT branches (200 + ping + rich error frame) are added to this
 * file in C3b, driven by a gate + FakeClock (deterministic, no real timers). See
 * docs/rfc/pre-response-abort-handling.md §4 + exp/q2-oracle/REPORT.md (Q2 GO).
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

describe("③ pre-stream-grace — C3a golden pre-capture (current behavior, before ③)", () => {
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
    test(`pre-response upstream ${status} → proxy emits HTTP ${status} (PRE-COMMIT baseline, no stream opened)`, async () => {
      mode = { kind: "http-error", status }
      const res = await streamRequest(`grace-c3a-${status}`)

      // Current behavior: runRequest throws the HTTPError before streamSSE → forwardError
      // emits the real HTTP status (NOT a 200 SSE stream). ③ with grace>0 + a fast upstream
      // (resolves within grace) keeps this exact shape — the divergence only appears for a
      // stall past the grace window (C3b).
      expect(res.status).toBe(status)
      expect(res.headers.get("content-type")).toContain("application/json")
      // Current forwardError default-path Anthropic envelope: `{ error: { message, type:"error" } }`
      // — note the mis-shaped axis (no top-level `type`, inner `error.type` is the literal "error",
      // `error.message` carries the raw upstream body). C3b's `toAnthropicSseErrorData` reshapes
      // this into a canonical SSE error frame for the COMMIT path; the HTTP (PRE-COMMIT) path here
      // is unchanged. Locking the faithful current shape so a regression is caught.
      const body = (await res.json()) as { type?: string; error?: { type?: string; message?: string } }
      expect(body.error?.type).toBe("error")
      expect(body.error?.message).toContain(`mock ${status}`)

      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: `grace-c3a-${status}`, limit: 5 }).entries[0]
      expect(entry?.state).toBe("failed")
    })
  }
})

describe("③ pre-stream-grace — COMMIT (grace elapses, upstream silent then resolves)", () => {
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
      streamKeepalivePingSec: 0, // commit path floors to 30s; we never advance that far, so only the explicit first ping appears
      streamKeepaliveGraceSec: 5,
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("grace elapsed → 200 + immediate ping, then upstream completes → content forwarded after the ping", async () => {
    const resP = streamRequest("grace-commit-complete")
    await gateReachedP // upstream fetch reached, the grace race is pending
    await clock.advance(5_000) // fire the grace timer → COMMIT (200 + first ping)
    const res = await resP
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    openGate() // upstream returns → pump forwards the content on the SAME sink
    const text = await res.text()
    const types = frameTypesInOrder(text)
    expect(types[0]).toBe("ping") // the COMMIT first ping precedes all real content (③ keepalive)
    expect(types).toContain("message_start")
    expect(types).toContain("message_stop")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "grace-commit-complete", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })

  test("grace elapsed → 200 + ping, then upstream 401 → rich SSE error frame (HTTP status stays 200)", async () => {
    commitMode = "error-401"
    const resP = streamRequest("grace-commit-401")
    await gateReachedP
    await clock.advance(5_000) // COMMIT
    const res = await resP
    expect(res.status).toBe(200) // committed — the HTTP status is locked at 200, the error degrades to an SSE frame

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

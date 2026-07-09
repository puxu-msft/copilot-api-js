/**
 * POST-COMMIT terminal-failure anchor CLOSE-OFF (spec 2026-07-08-buffered-keepalive-empty-text-anchor
 * §10.5 / §3.4). When the handler-owned unique injector lit a synthetic empty-text anchor block during
 * the pre-response silence window (live / delayed-commit, `empty_text` mode) and the request THEN fails
 * POST-COMMIT (HTTP status already 200-locked), the client is otherwise left with an OPEN
 * `content_block@0` — a protocol-incomplete stream. Every branch that writes an `event: error` frame
 * must first close the anchor off (`content_block_stop@0`, `synthetic:"anchor"`) so the block structure
 * stays balanced.
 *
 * Covered POST-COMMIT branches (handler-v4.ts delayed-commit streamSSE callback):
 *   - HTTPError (upstream 4xx/5xx) — the dominant divergence; anchor injected → stop@0 precedes the error.
 *   - reaper-cancel / header-wait timeout (generic AbortError) — anchor injected → stop@0 precedes the error.
 *   - decideRoute reject — a STRUCTURALLY FAST failure (decideRoute is sync right after parse, so an
 *     anchor can never actually be injected before it resolves); the close-off is defensive. Tested for
 *     byte-EQUIVALENCE: injected=false → NO stray stop@0 (the inert path is unchanged).
 *   - client-abort — EXCLUDED by design (writes zero frames; nothing to close off).
 *
 * Deterministic: FakeClock drives the heartbeat cadence; a gated upstream withholds its result until the
 * anchor has been injected during the stall.
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

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  dataFramesOfType,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "claude-opus-4.8"

async function drain(n = 60): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function errorBody(status: number): string {
  return JSON.stringify({ type: "error", error: { type: "authentication_error", message: `mock ${status}` } })
}

describe("live POST-COMMIT terminal failure — anchor close-off before the error frame", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>
  // The upstream outcome the gate delivers once opened: an HTTP 401 (HTTPError branch) or a rejected
  // fetch with a generic AbortError (reaper-cancel / header-wait timeout branch).
  let commitMode: "http-401" | "abort"

  // A gated upstream that signals when the fetch is reached, then WITHHOLDS its result until the test
  // opens the gate — modelling the pre-response silence the anchor injector fires into.
  const gatedFetchMock = mock((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    gateReached()
    return gateOpenP.then(() =>
      commitMode === "abort" ?
        Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
      : new Response(errorBody(401), { status: 401, headers: { "content-type": "application/json" } }),
    )
  })

  beforeEach(() => {
    clock.install()
    gatedFetchMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    commitMode = "http-401"
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2, //   cadence 2s
      streamCommitAfterSec: 2, //     window fires at 2s → commit 200; anchor injector then fires on the stall
      streamKeepaliveMode: "empty_text", // the mode under test (synthetic prelude on pre-response silence)
      protectStreamingGeneration: false, // live path — models the §10.1 live pre-response incident
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  async function streamRequest(sessionId: string): Promise<Response> {
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    return app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
  }

  /** Drive a gated request past commit + the stall (so the anchor is injected), then open the gate to fail. */
  async function injectAnchorThenFail(sessionId: string): Promise<string> {
    const resP = streamRequest(sessionId)
    await gateReachedP //           upstream fetch reached (runRequest still pending — gate closed)
    await clock.advance(2_000) //   commit window fires → COMMIT path opens the 200 SSE + starts the callback
    await drain(120) //             let the callback arm the heartbeat timer + write the cold-start immediate ping
    await clock.advance(2_500) //   the heartbeat cadence now elapses (NO real frame + NO open block) → inject anchor
    await drain(120) //             let the injector's three sink.writes (message_start + start@0 + delta@0) flush
    const res = await resP
    expect(res.status).toBe(200)
    openGate() //                   upstream now fails POST-COMMIT (HTTP status locked at 200 → SSE error frame)
    return res.text()
  }

  /** Assert the synthetic anchor prelude was injected AND closed off (stop@0) BEFORE the error frame. */
  function expectAnchorClosedBeforeError(text: string): void {
    const types = frameTypesInOrder(text)

    // The synthetic prelude was injected during the stall (pre-response silence → fabricated message_start).
    expect(types).toContain("message_start")
    const starts = dataFramesOfType(text, "content_block_start")
    expect(starts.some((s) => s.index === 0 && (s.content_block as { type?: string })?.type === "text")).toBe(true)

    // The anchor is closed off with a content_block_stop AT INDEX 0.
    const stops = dataFramesOfType(text, "content_block_stop")
    expect(stops.some((s) => s.index === 0)).toBe(true)

    // Ordering (the whole point): the close-off precedes the terminal error frame, so the client never
    // sees an OPEN block followed straight by an error.
    const idxStop = types.indexOf("content_block_stop")
    const idxError = types.indexOf("error")
    expect(idxStop).toBeGreaterThan(-1)
    expect(idxError).toBeGreaterThan(-1)
    expect(idxError).toBeGreaterThan(idxStop)
  }

  test("HTTPError branch — upstream 401 after an injected anchor → content_block_stop@0 precedes the error frame", async () => {
    commitMode = "http-401"
    const text = await injectAnchorThenFail("live-postcommit-anchor-401")
    expectAnchorClosedBeforeError(text)
    // The canonical error.type is still preserved on the frame (Q2 — the client SDK branches on it).
    expect((dataFramesOfType(text, "error")[0]?.error as { type?: string } | undefined)?.type).toBe("authentication_error")
  })

  test("reaper-cancel / timeout branch — a generic AbortError after an injected anchor → stop@0 precedes the error frame", async () => {
    commitMode = "abort"
    const text = await injectAnchorThenFail("live-postcommit-anchor-timeout")
    expectAnchorClosedBeforeError(text)
    // The timeout/reaper branch synthesizes an api_error terminator.
    expect((dataFramesOfType(text, "error")[0]?.error as { type?: string } | undefined)?.type).toBe("api_error")
  })

  test("decideRoute reject — inert close-off (injected=false) → error frame with NO stray content_block_stop@0 (equivalence)", async () => {
    // decideRoute reject is structurally fast (sync right after parse), so no anchor is ever injected;
    // the close-off must be a no-op. commit=0 routes the reject through the COMMIT-path branch (a 200 SSE
    // error frame) instead of the pre-commit 400. A non-Anthropic vendor model → decideRoute rejects.
    setStateForTests({ streamCommitAfterSec: 0 })
    setModels({ object: "list", data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "live-postcommit-reject" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
    expect(res.status).toBe(200) // committed immediately → the reject degrades to a 200 SSE error frame
    const text = await res.text()
    const types = frameTypesInOrder(text)
    expect(types).toContain("error")
    // No anchor was injected → the inert close-off wrote NOTHING: zero content_block_stop frames.
    expect(types).not.toContain("content_block_stop")
    expect(dataFramesOfType(text, "content_block_stop")).toHaveLength(0)
  })
})

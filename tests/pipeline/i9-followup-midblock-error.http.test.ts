/**
 * I9 re-review follow-up (item 2) — does an H2 `event:error` arriving MID-BLOCK (after a
 * content_block_delta, before its own content_block_stop) reach the SAME `response-terminal{failed}`
 * outcome the fix wires for a clean-drain error, or does the grammar's `acceptTerminal` open-unit
 * guard intercept it first and swallow both signals?
 *
 * `delivery/grammar.ts`'s `acceptTerminal` returns EARLY when `mode==="unit" && openUnit` is set —
 * before ever reaching the `response-terminal` construction — and instead emits `discard-open-unit`
 * + a `protocol-error{semantic:"terminal-with-open-unit"}`. `isUpstreamFailure` only recognizes
 * `"terminal-failure"`/`"adapter-exception"`, NOT `"terminal-with-open-unit"` — so `sawFailure` never
 * flips, `sawTerminal` never flips (no `response-terminal` outcome was ever produced), and the
 * mid-flight block's already-buffered content in `openFrames` is discarded by `discardOpen`.
 *
 * GATED, and the gate is the point. Emitting the failed terminal here (so `sawUpstreamError` fires and the retry stops) was implemented, measured, and reverted: it makes the buffered terminal-commit drain flush its whole buffer, so the client received `content_block_start` + a delta with no `content_block_stop`, followed by TWO terminals — the upstream error and a synthesised truncation error. A malformed block is worse than a wasted retry, and block-level delivery is a project axiom.
 * Fixing it properly requires the drain to drop frames past the last commit boundary, which needs block-level awareness the compatibility-era driver does not have. That is Task 4's owner cutover. This test asserts the DESIRED behaviour and is skipped until then, so whoever lands Task 4 finds it here rather than rediscovering the shape.
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

/** message_start → content_block_start(0) → ONE delta → terminal `event:error` — NO content_block_stop, NO message_stop. The block is still OPEN when the error arrives. */
function buildMidBlockH2(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_midblock", model }),
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mid-block" } })}\n\n`,
    `event: error\ndata: ${JSON.stringify({ error: { type: "overloaded_error", message: "upstream overloaded" } })}\n\n`,
  ]
}

let upstreamCalls = 0
const upstreamFetchMock = mock(() => {
  upstreamCalls++
  return Promise.resolve(createSseResponse(buildMidBlockH2(MODEL)))
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe.skip("[GATED — requires Task 4 owner cutover: the buffered terminal drain must drop frames past the last commit boundary] I9 follow-up probe — H2 error arriving MID-BLOCK (open unit, no content_block_stop)", () => {
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

  test("commits the terminal error without retrying, and without leaking the block that never closed", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "i9-followup-midblock" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    const types = frameTypesInOrder(sse)

    // Same discriminator as the sibling probe: exactly ONE upstream call, not a retry loop.
    expect(sse).not.toContain("mid-block")
    expect(upstreamCalls).toBe(1)
    expect(types).toContain("error")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "i9-followup-midblock", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
  })
})

import {
  //
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import { createRequestContext } from "~/lib/context/request"
import { settleMessagesOwnerFailure } from "~/routes/messages/owner-failure-settlement"

function env(): RequestEnvelope {
  return { ctx: createRequestContext({ endpoint: "anthropic-messages" }) } as RequestEnvelope
}

const partial = { usage: { input_tokens: 3, output_tokens: 2 }, stop_reason: "end_turn", content: [{ type: "text", text: "partial" }] }

test("messages owner client-gone settles aborted with the forwarded snapshot and partial", () => {
  const request = env()
  let recorded = 0
  expect(
    settleMessagesOwnerFailure(
      { kind: "client-aborted", reason: "client-gone", partialDelivery: true },
      request,
      "claude-test",
      () => {
        recorded++
        request.ctx.setForwardedResponse({ sseEvents: [{ type: "ping", raw: "ping", offsetMs: 0 }] })
      },
      partial,
    ),
  ).toBe(true)
  expect(recorded).toBe(1)
  expect(request.ctx.state).toBe("aborted")
  expect(request.ctx.forwardedResponse?.sseEvents).toHaveLength(1)
})

test("messages owner session termination is quiet when settled and loud when pending", () => {
  const settled = env()
  settled.ctx.complete({ success: true, model: "claude-test", usage: { input_tokens: 0, output_tokens: 0 }, content: null })
  expect(settleMessagesOwnerFailure({ kind: "delivery-finished", reason: "session-terminating" }, settled, "claude-test", () => {}, partial)).toBe(true)
  expect(settled.ctx.state).toBe("completed")

  const pending = env()
  expect(
    settleMessagesOwnerFailure(
      { kind: "fail-loud", reason: "session-terminating", error: new Error("session ended") },
      pending,
      "claude-test",
      () => {},
      partial,
      { cause: new Error("upstream cause") },
    ),
  ).toBe(true)
  expect(pending.ctx.state).toBe("failed")
  expect(pending.ctx.response?.error).toContain("session ended")
})

test("messages owner wire-torn stays on the caller's failed terminal path", () => {
  const request = env()
  expect(settleMessagesOwnerFailure({ kind: "fail-loud", reason: "wire-torn", error: new Error("wire torn") }, request, "claude-test", () => {}, partial)).toBe(
    false,
  )
  expect(request.ctx.state).toBe("pending")
})

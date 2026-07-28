/**
 * The SHIPPED DEFAULT is suppression — an oracle for the one decision this whole feature exists for.
 *
 * Why this file exists: the merged-state review flipped `state-defaults.ts` back to `"error"` and the
 * entire suite stayed byte-identical (6512 pass / 14 fail, zero tests red). Every other refusal test
 * sets `refusalSseRewrite` explicitly, so none of them can observe the default — and the config
 * hot-reload matrix compares against `CONFIG_MANAGED_DEFAULTS.refusalSseRewrite`, i.e. the production
 * constant is its own expected value, which stays green no matter what that constant says.
 *
 * The load-bearing test is the third one: it never mentions a mode. It builds a REAL request context
 * under an untouched runtime, reads back the policy that context froze, and asserts the OBSERVABLE
 * outcome is a suppressed turn. Flipping the default turns it red because the wire changes shape.
 *
 * Failure mode being guarded: an unrelated config refactor, or a merge that takes the wrong side of
 * `CONFIG_MANAGED_DEFAULTS`, silently restores `"error"` — the primary goal (never interrupt the
 * client's conversation) stops holding and nothing but a human using Claude Code would notice.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamEvent } from "~/types/api/anthropic"

import { createRefusalRewriter } from "~/lib/anthropic/recover-refusal"
import { createRequestContext } from "~/lib/context/request"
import { createBus } from "~/lib/observability"
import {
  //
  CONFIG_MANAGED_DEFAULTS,
  state,
} from "~/lib/state"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** The real 2026-07-27 `cyber` sample: zero content blocks, then a refusal with no `message_stop`. */
const MESSAGE_START = { type: "message_start", message: { content: [], role: "assistant" } }
const CYBER_REFUSAL_DELTA = {
  type: "message_delta",
  delta: {
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "This request triggered restrictions on violative cyber content" },
    stop_sequence: null,
  },
  usage: { output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } },
}

function frameTypes(frames: Array<ServerSentEventMessage>): Array<string> {
  return frames.map((f) => (JSON.parse(f.data ?? "{}") as { type?: string }).type ?? f.event ?? "?")
}

describe("shipped default for contentless refusals", () => {
  useIsolatedRuntime()

  test("the config-managed default is suppression", () => {
    // Expected is a hand-written literal; the production constant is the SUBJECT, never the oracle.
    expect(CONFIG_MANAGED_DEFAULTS.refusalSseRewrite).toBe("end_turn")
  })

  test("an untouched runtime carries that default on `state` (not just in the constant table)", () => {
    expect(state.refusalSseRewrite).toBe("end_turn")
  })

  test("with NO refusal config, a real request context suppresses the refusal into a complete turn", () => {
    // This test deliberately names no mode. It reads the policy a real ctx froze under default
    // config, so it observes the DEFAULT rather than restating it.
    const bus = createBus()
    const ctx = createRequestContext({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", publisher: bus.scope("request") })
    const rewriter = createRefusalRewriter({ policy: ctx.refusalPolicy, staticVars: { model: "claude-opus-5", request_id: ctx.id } })

    const out: Array<ServerSentEventMessage> = []
    for (const ev of [MESSAGE_START, CYBER_REFUSAL_DELTA]) {
      out.push(...rewriter.processEvent(ev as unknown as StreamEvent, { data: JSON.stringify(ev) }))
    }

    // Suppression's observable shape: a synthetic text block, an end_turn delta, and a terminator —
    // a normal completed turn. Under `error` this would be a single `event: error` frame instead;
    // under passthrough it would be the untouched refusal delta.
    expect(frameTypes(out)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    const delta = JSON.parse(out[4].data ?? "") as { delta: { stop_reason: string } }
    expect(delta.delta.stop_reason).toBe("end_turn")
    const text = (JSON.parse(out[2].data ?? "") as { delta: { text: string } }).delta.text
    // Non-empty matters on its own: an empty recovery text is what makes Claude Code spin an extra
    // turn (exp/cli-e2e-stall), which defeats suppression even though the frames look right.
    expect(text.length).toBeGreaterThan(0)
    expect(out.some((f) => f.event === "error")).toBe(false)
  })
})

/**
 * Recover-tool-call observability wiring: the recoverer is the ONLY place the rebuilt
 * tool names are knowable (the upstream-original track keeps the raw downgraded TEXT with
 * no tool_use block — Option A, response-rewrite-golden's S3A_OUTBOUND). This suite pins
 * that BOTH the streaming `transform` and the non-streaming `transformWhole` legs emit a
 * `tool-call-recovered` feature carrying `detail.tools` = the recovered names, so the
 * `[RECOVER]` log AND the completion line's `tool_use(<names>)` token can show them.
 *
 * Drives the REAL `recover-tool-call` rewrite from `ANTHROPIC_RESPONSE_REWRITES` with a
 * real `createRequestContext` + a capturing bus publisher — removing the detail wiring
 * (or the non-streaming feature record, previously silent) turns this red.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { UpstreamFrame } from "~/lib/pipeline/types"

import { ANTHROPIC_RESPONSE_REWRITES } from "~/lib/codec/anthropic/response-rewrite-adapters"
import { createRequestContext } from "~/lib/context/request"
import { createBus } from "~/lib/observability"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

const recoverRewrite = ANTHROPIC_RESPONSE_REWRITES.find((r) => r.name === "recover-tool-call")

// Downgrade text: residue `<function_calls>` + a single `<invoke name="search">` (the shape
// GHC emits when it downgrades a tool call to prose). Mirrors response-rewrite-golden's INVOKE_TEXT.
const INVOKE_TEXT = '<function_calls><invoke name="search"><parameter name="query">weather</parameter></invoke>'

function frame(obj: Record<string, unknown>): UpstreamFrame {
  return { event: obj.type as string, data: JSON.stringify(obj) } as UpstreamFrame
}

/** Capture every `request.feature_applied` event on a fresh bus + return the wired ctx. */
function makeCapturingCtx(): { ctx: ReturnType<typeof createRequestContext>; features: Array<ObservabilityEvent> } {
  const bus = createBus()
  const features: Array<ObservabilityEvent> = []
  bus.subscribe((e) => {
    if (e.kind === "request.feature_applied") features.push(e)
  })
  const ctx = createRequestContext({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", publisher: bus.scope("request") })
  return { ctx, features }
}

function recoveredFeature(features: Array<ObservabilityEvent>): { detail?: { tools?: unknown } } | undefined {
  return features.find((e) => e.kind === "request.feature_applied" && (e as { feature?: string }).feature === "tool-call-recovered") as never
}

describe("recover-tool-call feature detail wiring", () => {
  useIsolatedRuntime()

  test("streaming transform records tool-call-recovered with detail.tools = recovered names", () => {
    const { ctx, features } = makeCapturingCtx()
    const env = { ctx, targetEndpoint: "/v1/messages", body: { tools: [{ name: "search" }] } } as unknown as RequestEnvelope
    const st = recoverRewrite!.createState!(env)

    // Tier-A downgrade sequence: text block carrying the `<invoke>` markup, then a
    // message_delta with stop_reason=tool_use → COMMIT synthesizes the tool_use.
    const seq: Array<UpstreamFrame> = [
      frame({ type: "message_start", message: { role: "assistant", content: [] } }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: INVOKE_TEXT } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ]
    for (const f of seq) recoverRewrite!.transform(f, st)

    const feat = recoveredFeature(features)
    expect(feat).toBeDefined()
    expect(feat?.detail?.tools).toEqual(["search"])
  })

  test("streaming: multiple recovered tool_use in one downgraded tail → all names collected in call order", () => {
    const { ctx, features } = makeCapturingCtx()
    const env = { ctx, targetEndpoint: "/v1/messages", body: { tools: [{ name: "search" }, { name: "fetch" }] } } as unknown as RequestEnvelope
    const st = recoverRewrite!.createState!(env)

    // One downgraded tail carrying TWO `<invoke>` regions → emitCommit emits both synthesized
    // tool_use blocks in a SINGLE `out`; the flatMap must collect BOTH names, preserving order.
    const twoInvokes =
      '<function_calls><invoke name="search"><parameter name="query">weather</parameter></invoke><invoke name="fetch"><parameter name="url">x</parameter></invoke>'
    const seq: Array<UpstreamFrame> = [
      frame({ type: "message_start", message: { role: "assistant", content: [] } }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: twoInvokes } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ]
    for (const f of seq) recoverRewrite!.transform(f, st)

    expect(recoveredFeature(features)?.detail?.tools).toEqual(["search", "fetch"])
  })

  test("non-streaming transformWhole records tool-call-recovered with detail.tools (was previously silent)", () => {
    const { ctx, features } = makeCapturingCtx()
    const env = { ctx, targetEndpoint: "/v1/messages", body: { tools: [{ name: "search" }] } } as unknown as RequestEnvelope
    const response = {
      role: "assistant",
      model: "claude-opus-4-8",
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: INVOKE_TEXT }],
    }

    const out = recoverRewrite!.transformWhole!(response, env) as { content: Array<{ type: string; name?: string }> }
    // Sanity: the helper actually rebuilt the tool_use (else the assertion below is vacuous).
    expect(out.content.some((b) => b.type === "tool_use" && b.name === "search")).toBe(true)

    const feat = recoveredFeature(features)
    expect(feat).toBeDefined()
    expect(feat?.detail?.tools).toEqual(["search"])
  })

  test("non-streaming transformWhole with no downgrade records NOTHING (no false recovery)", () => {
    const { ctx, features } = makeCapturingCtx()
    const env = { ctx, targetEndpoint: "/v1/messages", body: { tools: [{ name: "search" }] } } as unknown as RequestEnvelope
    const response = {
      role: "assistant",
      model: "claude-opus-4-8",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "just a normal answer" }],
    }
    recoverRewrite!.transformWhole!(response, env)
    expect(recoveredFeature(features)).toBeUndefined()
  })
})

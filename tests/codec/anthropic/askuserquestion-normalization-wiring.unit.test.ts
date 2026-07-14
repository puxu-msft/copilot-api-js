/**
 * Adapter wiring seam (merged-state review 建议 1): the tool-input-decode rewrite must spread
 * `...normalizationObserver(env.ctx)` into BOTH `createState` (streaming) and `transformWhole`
 * (non-streaming) decoder options, so AskUserQuestion salvage/strip diagnostics reach
 * `ctx.pipelineInfo`. The core callback (decode-tool-input) and the ctx setter (request-emit-methods)
 * are unit-tested separately; this closes the seam between them — driving the REAL rewrite from
 * `ANTHROPIC_RESPONSE_REWRITES` so removing either spread turns this red.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import { ANTHROPIC_RESPONSE_REWRITES } from "~/lib/codec/anthropic/response-rewrite-adapters"
import { createRequestContext } from "~/lib/context/request"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

const decodeRewrite = ANTHROPIC_RESPONSE_REWRITES.find((r) => r.name === "tool-input-decode")

describe("AskUserQuestion normalization adapter wiring (transformWhole seam)", () => {
  useIsolatedRuntime()

  test("transformWhole spreads normalizationObserver → ctx.pipelineInfo.askUserQuestionNormalization", () => {
    // Default state has backfillQuestionFromHeader:true + decodeToolInputFields:{AskUserQuestion:["questions"]}.
    const ctx = createRequestContext({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    const env = { ctx } as unknown as RequestEnvelope
    const response = {
      content: [
        { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "怎么办？" } },
      ],
    }
    decodeRewrite?.transformWhole?.(response, env)
    // Salvaged the hoisted top-level question into the single item + stripped it — persisted to pipelineInfo.
    expect(ctx.pipelineInfo?.askUserQuestionNormalization).toMatchObject({ salvaged: true, strippedKeys: ["question"] })
  })
})

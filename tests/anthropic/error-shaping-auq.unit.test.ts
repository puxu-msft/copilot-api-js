/**
 * Unit tests for Phase 4's AUQ (AskUserQuestion) synthesis builders
 * (`src/lib/anthropic/error-shaping.ts`): `buildAskUserQuestionResponse` (stream:false, whole
 * `AnthropicMessageResponse`) and `buildAskUserQuestionFrames` (stream:true, self-contained SSE
 * frame sequence). Both consume a `{kind:"ask-user-question"}` `ShapingDecision` (Phase 1) and
 * complete the SECOND render pass (`{model}`/`{request_id}`) via `renderAuqQuestion` — Phase 1's
 * `decide()` already completed the first pass (`{error_type}`/`{status}`).
 *
 * Pure functions — no runtime, no I/O.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { backfillAskUserQuestionHeaders } from "~/lib/anthropic/decode-tool-input-core"
import {
  //
  buildAskUserQuestionFrames,
  buildAskUserQuestionResponse,
  type ShapingDecision,
} from "~/lib/anthropic/error-shaping"
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"

type AuqQuestions = Extract<ShapingDecision, { kind: "ask-user-question" }>["questions"]

const decision = (questions: AuqQuestions): Extract<ShapingDecision, { kind: "ask-user-question" }> => ({ kind: "ask-user-question", questions })

const oneQuestion: AuqQuestions = [
  {
    question: "上游返回 quota_exceeded（模型 {model}，请求 {request_id}），如何继续？",
    header: "如何继续？",
    multiSelect: false,
    options: [
      { label: "等待后重试", description: "配额恢复后再次发送本次请求" },
      { label: "切换模型", description: "改用未超额的其他模型继续" },
      { label: "放弃", description: "取消本次请求，不再重试" },
    ],
  },
]

describe("buildAskUserQuestionResponse — stream:false variant", () => {
  test("produces a valid AnthropicMessageResponse with a single AskUserQuestion tool_use block, stop_reason:tool_use", () => {
    const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "claude-3-5-sonnet-latest", reqId: "req_test" })
    expect(res.stop_reason).toBe("tool_use")
    expect(res.content).toHaveLength(1)
    const block = res.content[0] as unknown as { type: string; name?: string; input?: { questions?: Array<unknown> } }
    expect(block.type).toBe("tool_use")
    expect(block.name).toBe("AskUserQuestion")
    expect(block.input?.questions).toHaveLength(1)
  })

  test("第二遍渲染：{model}/{request_id} 被替换为 ctx 里的真实值", () => {
    const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "claude-3-5-sonnet-latest", reqId: "req_test" })
    const block = res.content[0] as unknown as { input: { questions: Array<{ question: string }> } }
    expect(block.input.questions[0]?.question).toBe("上游返回 quota_exceeded（模型 claude-3-5-sonnet-latest，请求 req_test），如何继续？")
    expect(block.input.questions[0]?.question).not.toContain("{model}")
    expect(block.input.questions[0]?.question).not.toContain("{request_id}")
  })

  test("tool_use id starts with toolu_", () => {
    const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "m", reqId: "r" })
    const block = res.content[0] as unknown as { id: string }
    expect(block.id).toMatch(/^toolu_/)
  })

  // MED-3 independent wire-shape oracle. We have NO real-Claude-Code consumption test (the
  // "CC renders a synthetic AskUserQuestion as an interactive prompt" assumption is inherited
  // from spec, UNVERIFIED — see task-4-report.md §MED-3). What we CAN pin independently is that
  // the synthesized `input.questions` satisfies the SAME structural contract real CC-facing
  // traffic must satisfy: `backfillAskUserQuestionHeaders` (written for real upstream AUQ traffic,
  // NOT for this test) rejects a `questions[]` item that has a `header` but no `question` ("must
  // have a question"). It backfills only when `question` is ABSENT — so if our synthesis already
  // provides `question` on every item, this consumer returns the input by REFERENCE (===),
  // proving the wire shape is already CC-valid without needing repair. An independent function
  // as oracle, not a self-referential re-assertion of our own builder output.
  test("MED-3 oracle: synthesized questions[] already satisfy CC's 'must have a question' contract (backfill is a reference no-op)", () => {
    const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "m", reqId: "r" })
    const block = res.content[0] as unknown as { input: { questions: Array<unknown> } }
    const input = block.input
    // Identity return ⟹ zero items needed a question backfilled ⟹ every item already CC-valid.
    expect(backfillAskUserQuestionHeaders("AskUserQuestion", input)).toBe(input)
  })

  // FIX-B (Critical root-cause defense): the MED-3 oracle above only validates question/header —
  // it does NOT touch `options`, which is exactly how the Phase-1 plain-string `options` bug slipped
  // through. This oracle pins the `options` wire shape against REAL Claude Code traffic. The
  // independent ground truth is `tests/infra/debug-dry-run-pipeline.http.test.ts:108` — a captured
  // real GHC-downgrade AskUserQuestion whose `options` are `[{ label, description }]` objects (NOT
  // plain strings). CC 2.1.207 (app.pretty.js:318507) validates this schema and rejects a
  // plain-string option, so a synthesized string `options` would silently fail CC-side. We assert
  // every synthesized option is EXACTLY `{ label: string, description: string }` — exact key set
  // (no extra/missing keys) + both string-typed. A plain-string regression has no keys and fails
  // loudly; a missing `description` fails; an extra field fails.
  test("FIX-B oracle: synthesized options[] match CC's real-traffic {label,description} object schema (debug-dry-run-pipeline.http.test.ts:108)", () => {
    // The canonical real-traffic option shape, copied verbatim from the fixture cited above — the
    // schema source of truth, not a self-fabricated expectation.
    const realTrafficOption = { label: "只做 #1 (rename)", description: "仅 messages/handler.ts → web-search-direct.ts" }
    const ccOptionKeys = Object.keys(realTrafficOption).sort() // ["description", "label"]

    const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "m", reqId: "r" })
    const block = res.content[0] as unknown as { input: { questions: Array<{ options: Array<unknown> }> } }
    const options = block.input.questions[0]?.options
    expect(options).toBeDefined()
    expect(options?.length).toBeGreaterThan(0)
    for (const opt of options ?? []) {
      expect(typeof opt).toBe("object")
      expect(opt).not.toBeNull()
      const o = opt as Record<string, unknown>
      expect(Object.keys(o).sort()).toEqual(ccOptionKeys) // exactly {label, description}, no more/less
      expect(typeof o.label).toBe("string")
      expect(typeof o.description).toBe("string")
    }
  })
})

describe("buildAskUserQuestionFrames — stream:true variant", () => {
  test("produces a complete, self-contained SSE frame sequence: message_start → content_block_start(tool_use) → input_json_delta → content_block_stop → message_delta(stop_reason:tool_use) → message_stop", () => {
    const frames = buildAskUserQuestionFrames(decision(oneQuestion), { model: "m", reqId: "r" })
    const events = frames.map((f) => f.event)
    expect(events).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
  })

  test("every frame is tagged synthetic:error-shaping-auq (richest-data-flow — must be distinguishable from real upstream traffic)", () => {
    const frames = buildAskUserQuestionFrames(decision(oneQuestion), { model: "m", reqId: "r" })
    for (const f of frames) expect(readSyntheticKind(f)).toBe("error-shaping-auq")
  })

  test("第二遍渲染也在 streaming 变体里生效", () => {
    const frames = buildAskUserQuestionFrames(decision(oneQuestion), { model: "claude-3-5-sonnet-latest", reqId: "req_test" })
    const deltaFrame = frames.find((f) => f.event === "content_block_delta")
    const data = JSON.parse(deltaFrame?.data ?? "{}") as { delta: { partial_json: string } }
    expect(data.delta.partial_json).toContain("claude-3-5-sonnet-latest")
    expect(data.delta.partial_json).toContain("req_test")
    expect(data.delta.partial_json).not.toContain("{model}")
  })
})

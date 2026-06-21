/**
 * HTTP tests for POST /api/debug/dry-run-pipeline (Phase 1, response side, Anthropic).
 *
 * Verifies the offline pipeline dry-run feeds a synthetic upstream through the real
 * v4 S5 response-rewrite chain (ANTHROPIC_RESPONSE_REWRITES) and returns the forwarded
 * frames + captured feature events — without touching GHC or polluting history.
 */

import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { StateSnapshot } from "~/lib/state"

import {
  //
  setModels,
  setStateForTests,
  snapshotStateForTests,
  restoreStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { createFullTestApp } from "../helpers/test-app"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

const app = createFullTestApp()

function seedModel(): void {
  setModels({
    object: "list",
    data: [
      mockModel("claude-sonnet-4", {
        vendor: "Anthropic",
        capabilities: {
          family: "claude",
          type: "chat",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 16000, max_prompt_tokens: 1_000_000 },
        },
      }),
    ],
  })
}

async function post(payload: unknown): Promise<Response> {
  return app.request("/api/debug/dry-run-pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

/** Build an Anthropic SSE upstream emitting one AskUserQuestion tool_use whose `questions` is `questionsValue`. */
function askUserQuestionUpstream(questionsValue: string): Array<{ raw: string; type: string }> {
  const ev = (o: Record<string, unknown>): { raw: string; type: string } => ({ raw: JSON.stringify(o), type: o.type as string })
  return [
    ev({ type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-opus-4-8", stop_reason: null } }),
    ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "AskUserQuestion", input: {} } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ questions: questionsValue }) } }),
    ev({ type: "content_block_stop", index: 0 }),
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    ev({ type: "message_stop" }),
  ]
}

/** Reassemble the forwarded tool_use block's `questions` from the response's forwarded SSE frames. */
function forwardedQuestions(result: Array<{ data?: string }>): unknown {
  const chunks: Array<string> = []
  for (const f of result) {
    if (typeof f.data !== "string") continue
    let p: { type?: string; delta?: { type?: string; partial_json?: string } }
    try {
      p = JSON.parse(f.data)
    } catch {
      continue
    }
    if (p.type === "content_block_delta" && p.delta?.type === "input_json_delta") chunks.push(p.delta.partial_json ?? "")
  }
  return (JSON.parse(chunks.join("")) as { questions?: unknown }).questions
}

describe("POST /api/debug/dry-run-pipeline", () => {
  let snap: StateSnapshot

  beforeAll(async () => {
    await bootstrapTestRuntime()
  })

  afterAll(async () => {
    await resetTestRuntime()
  })

  beforeEach(() => {
    snap = snapshotStateForTests()
    setStateForTests({ decodeToolInputFields: { AskUserQuestion: ["questions"] }, decodeAllToolInputFields: false, backfillQuestionFromHeader: true })
    seedModel()
  })

  afterEach(() => {
    restoreStateForTests(snap)
  })

  test("decodes a stringified `questions` array on the forwarded stream", async () => {
    const upstream = askUserQuestionUpstream(JSON.stringify([{ header: "H", question: "Q" }]))
    const res = await post({ upstream: { sseEvents: upstream } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stream: boolean; result: Array<{ data?: string }>; fidelity: { clientFinal: boolean } }
    expect(body.stream).toBe(true)
    expect(body.fidelity.clientFinal).toBe(false)
    expect(forwardedQuestions(body.result)).toEqual([{ header: "H", question: "Q" }])
  })

  test("decodes + backfills the real GHC-downgrade shape (Chinese AskUserQuestion, mirrors reaped entry 1643)", async () => {
    // The live failure: upstream sent `input.questions` as a JSON-string-encoded array whose
    // items also LACK `question` (both degradations at once). Confirm current v4 code
    // deterministically (a) decodes the string → array AND (b) backfills question=header —
    // closing the "intermittent, entry reaped, can't reproduce" gap that drove this endpoint.
    const realQuestions = [
      { header: "文件组织", multiSelect: false, options: [{ label: "只做 #1 (rename)", description: "仅 messages/handler.ts → web-search-direct.ts" }] },
    ]
    const upstream = askUserQuestionUpstream(JSON.stringify(realQuestions))
    const res = await post({ upstream: { sseEvents: upstream } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: Array<{ data?: string }> }
    // Forwarded = decoded array WITH question backfilled from header (the client-final shape).
    const expected = realQuestions.map((q) => ({ ...q, question: q.header }))
    expect(forwardedQuestions(body.result)).toEqual(expected)
  })

  test("backfills a missing `question` from `header`", async () => {
    const upstream = askUserQuestionUpstream(JSON.stringify([{ header: "Pick one" }]))
    const res = await post({ upstream: { sseEvents: upstream } })
    const body = (await res.json()) as { result: Array<{ data?: string }> }
    expect(forwardedQuestions(body.result)).toEqual([{ header: "Pick one", question: "Pick one" }])
  })

  test("captures tool-input-decode-failed feature for a non-decodable `questions`", async () => {
    const upstream = askUserQuestionUpstream("not valid json")
    const res = await post({ upstream: { sseEvents: upstream } })
    const body = (await res.json()) as { diagnostics: { features: Array<{ feature: string; detail?: Record<string, unknown> }> } }
    const decodeFail = body.diagnostics.features.find((f) => f.feature === "tool-input-decode-failed")
    expect(decodeFail).toBeDefined()
    expect(decodeFail?.detail).toMatchObject({ tool: "AskUserQuestion", field: "questions", reason: "field-undecodable" })
  })

  test("404 for an unknown entryId", async () => {
    const res = await post({ entryId: "req_does_not_exist" })
    expect(res.status).toBe(404)
  })

  test("400 when neither entryId nor upstream is provided", async () => {
    const res = await post({ stream: true })
    expect(res.status).toBe(400)
  })

  // ── Request side (S1→S3) ──

  test("request side: inspectRequest runs S1-S3, returns per-stage snapshots + applied", async () => {
    const request = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }
    const res = await post({ request, stopAfter: "rewrite-in" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      side: string
      inspection: {
        stoppedAt: string
        stages: { parse?: { clientFormat?: string }; translate?: unknown; "rewrite-in"?: { applied?: Array<{ name: string; changed: boolean }> } }
      }
    }
    expect(body.side).toBe("request")
    expect(body.inspection.stoppedAt).toBe("rewrite-in")
    expect(body.inspection.stages.parse?.clientFormat).toBe("anthropic")
    expect(body.inspection.stages.translate).toBeDefined()
    expect(Array.isArray(body.inspection.stages["rewrite-in"]?.applied)).toBe(true)
  })

  test("request side: stopAfter=parse stops before S2", async () => {
    const request = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }
    const res = await post({ request, stopAfter: "parse" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { inspection: { stoppedAt: string; stages: { parse?: unknown; translate?: unknown } } }
    expect(body.inspection.stoppedAt).toBe("parse")
    expect(body.inspection.stages.parse).toBeDefined()
    expect(body.inspection.stages.translate).toBeUndefined()
  })

  test("request side: 400 when no request/entryId provided", async () => {
    const res = await post({ stopAfter: "rewrite-in" })
    expect(res.status).toBe(400)
  })
})

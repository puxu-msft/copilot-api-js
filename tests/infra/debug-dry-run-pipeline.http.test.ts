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
  setStateForTests,
  snapshotStateForTests,
  restoreStateForTests,
} from "~/lib/state"

import { createFullTestApp } from "../helpers/test-app"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

const app = createFullTestApp()

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
})

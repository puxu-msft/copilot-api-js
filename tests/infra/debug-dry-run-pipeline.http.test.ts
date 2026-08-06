/**
 * HTTP tests for POST /api/debug/dry-run-pipeline (all formats, request + response side).
 *
 * Verifies the offline pipeline dry-run feeds a synthetic/replayed request + upstream
 * through the real v4 driver — request side (S1→S3 inspectRequest, per-format codec) and
 * response side (S5 rewrite chain, Anthropic 4 / Responses 1 / CC + Gemini none) — without
 * touching GHC or polluting history, with honest per-format fidelity caveats (RFC §10).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

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
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ decodeToolInputFields: { AskUserQuestion: ["questions"] }, backfillQuestionFromHeader: true })
    seedModel()
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

  test("reports per-rewrite frameActions for the assembled Anthropic chain (T2 output content)", async () => {
    // Review #5: the T2 perRewrite/frameActions output (the inspector's headline) had no
    // content coverage. For an AskUserQuestion stream under default state, the assembled S5
    // chain is tool-input-decode (gated on the decode config) + server-tool-filter (always
    // ANTHROPIC) + thinking-signature-compat (default-on); each rewrite's `transform` runs
    // per frame, so perRewrite must report them with non-empty frameActions.
    const upstream = askUserQuestionUpstream(JSON.stringify([{ header: "H", question: "Q" }]))
    const res = await post({ upstream: { sseEvents: upstream }, stopAfter: "rewrite-out" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stages: { "rewrite-out": { rewritesAvailable: boolean; perRewrite: Array<{ name: string; frameActions: Array<unknown> }> } }
    }
    expect(body.stages["rewrite-out"].rewritesAvailable).toBe(true)
    const names = body.stages["rewrite-out"].perRewrite.map((r) => r.name)
    expect(names).toContain("tool-input-decode")
    expect(names).toContain("server-tool-filter")
    // Each reported rewrite actually saw frames (non-empty frameActions), not a phantom entry.
    for (const r of body.stages["rewrite-out"].perRewrite) expect(r.frameActions.length).toBeGreaterThan(0)
  })

  test("captures tool-input-decode-failed feature for a non-decodable `questions`", async () => {
    const upstream = askUserQuestionUpstream("not valid json")
    const res = await post({ upstream: { sseEvents: upstream } })
    const body = (await res.json()) as { diagnostics: { features: Array<{ feature: string; detail?: Record<string, unknown> }> } }
    const decodeFail = body.diagnostics.features.find((f) => f.feature === "tool-input-decode-failed")
    expect(decodeFail).toBeDefined()
    expect(decodeFail?.detail).toMatchObject({ tool: "AskUserQuestion", field: "questions", reason: "field-undecodable" })
  })

  test("appliesTo DISABLED side: all decode gates off → forwarded verbatim (questions stays stringified)", async () => {
    // Test gap A (deferred-items §2 Step1 item3): the decode rewrite's `appliesTo` OFF-side was never
    // locked. With every gate off the rewrite must NOT be assembled → byte-verbatim passthrough. This
    // is the class the live symptom would fall into if decode silently stopped via state/gating.
    setStateForTests({ decodeToolInputFields: {}, backfillQuestionFromHeader: false })
    const stringified = JSON.stringify([{ header: "H", question: "Q" }])
    const res = await post({ upstream: { sseEvents: askUserQuestionUpstream(stringified) } })
    const body = (await res.json()) as { result: Array<{ data?: string }> }
    expect(forwardedQuestions(body.result)).toBe(stringified) // still a STRING, not decoded to an array
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

  // ── Phase 3: all formats ──

  describe("all formats (Phase 3)", () => {
    test("request side: openai-cc parse runs, format switched, rewrite-in empty (no CC request rewrites)", async () => {
      const request = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }
      const res = await post({ request, format: "openai-cc", stopAfter: "parse" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { format: string; side: string; inspection: { stoppedAt: string; stages: { parse?: { clientFormat?: string } } } }
      expect(body.format).toBe("openai-cc")
      expect(body.side).toBe("request")
      expect(body.inspection.stages.parse?.clientFormat).toBe("openai-cc")
    })

    test("request side: openai-responses parse runs under the real codec", async () => {
      const request = { model: "gpt-4o", input: [{ role: "user", content: "hi" }] }
      const res = await post({ request, format: "openai-responses", stopAfter: "parse" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { format: string; inspection: { stages: { parse?: { clientFormat?: string } } } }
      expect(body.format).toBe("openai-responses")
      expect(body.inspection.stages.parse?.clientFormat).toBe("openai-responses")
    })

    test("request side: gemini parse translates Gemini→CC under the real codec", async () => {
      // Gemini body carries `model` for the dry-run (the live path takes it from the URL).
      const request = { model: "gemini-2.5-pro", contents: [{ role: "user", parts: [{ text: "hi" }] }] }
      const res = await post({ request, format: "gemini", stopAfter: "parse" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { format: string; inspection: { stages: { parse?: { clientFormat?: string } } } }
      expect(body.format).toBe("gemini")
      expect(body.inspection.stages.parse?.clientFormat).toBe("gemini")
    })

    test("response side: openai-responses runs the real fixIds rewrite (rewritesAvailable:true + the id is actually corrected)", async () => {
      const ev = (o: Record<string, unknown>): { raw: string; type: string } => ({ raw: JSON.stringify(o), type: o.type as string })
      const upstream = [
        ev({ type: "response.output_item.added", output_index: 0, item: { id: "item_A", type: "message" } }),
        ev({ type: "response.output_item.done", output_index: 0, item: { id: "item_B", type: "message" } }),
      ]
      const res = await post({ upstream: { sseEvents: upstream }, format: "openai-responses", stopAfter: "rewrite-out" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        format: string
        stages: { "rewrite-out": { rewritesAvailable: boolean; perRewrite: Array<{ name: string }> } }
        result: Array<{ data?: string }>
      }
      expect(body.format).toBe("openai-responses")
      expect(body.stages["rewrite-out"].rewritesAvailable).toBe(true)
      expect(body.stages["rewrite-out"].perRewrite.map((r) => r.name)).toContain("responses-fix-stream-ids")
      // Effect (not just "the rewrite was assembled"): fixStreamEventIds rewrites the `.done`
      // frame's item id back to the canonical `.added` id (item_B → item_A). Asserting the
      // OUTPUT — a name-only check would pass even if the rewrite were an identity no-op.
      const doneFrame = body.result
        .map((f) => (typeof f.data === "string" ? (JSON.parse(f.data) as { type?: string; item?: { id?: string } }) : undefined))
        .find((p) => p?.type === "response.output_item.done")
      expect(doneFrame?.item?.id).toBe("item_A")
    })

    test("response side: openai-responses with fixResponsesStreamIds OFF → rewritesAvailable:false (honest, gate-aware)", async () => {
      // Review #1: rewritesAvailable must reflect ACTUAL assembly (appliesTo-gated), not the
      // static registry length. With the only Responses rewrite's gate off, nothing assembles.
      setStateForTests({ fixResponsesStreamIds: false })
      const ev = (o: Record<string, unknown>): { raw: string; type: string } => ({ raw: JSON.stringify(o), type: o.type as string })
      const upstream = [ev({ type: "response.output_item.added", output_index: 0, item: { id: "item_A", type: "message" } })]
      const res = await post({ upstream: { sseEvents: upstream }, format: "openai-responses", stopAfter: "rewrite-out" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { stages: { "rewrite-out": { rewritesAvailable: boolean; perRewrite: Array<unknown> } } }
      expect(body.stages["rewrite-out"].rewritesAvailable).toBe(false)
      expect(body.stages["rewrite-out"].perRewrite).toEqual([])
    })

    test("response side: openai-cc has no driver rewrites (rewritesAvailable:false) + identity render", async () => {
      const frame = JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: "hi" }, index: 0 }] })
      const res = await post({ upstream: { sseEvents: [{ raw: frame, type: "" }] }, format: "openai-cc", stopAfter: "render" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        format: string
        stages: { "rewrite-out": { rewritesAvailable: boolean; perRewrite: Array<unknown> } }
        result: Array<{ data?: string }>
      }
      expect(body.format).toBe("openai-cc")
      expect(body.stages["rewrite-out"].rewritesAvailable).toBe(false)
      expect(body.stages["rewrite-out"].perRewrite).toEqual([])
      // No rewrites + identity render → the CC frame round-trips verbatim.
      expect(body.result[0]?.data).toBe(frame)
    })

    test("response side: gemini dry-run is CC-frame passthrough (identity codec) + the non-Gemini caveat", async () => {
      const frame = JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: "hi" }, index: 0 }] })
      const res = await post({ upstream: { sseEvents: [{ raw: frame, type: "" }] }, format: "gemini", stopAfter: "render" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        format: string
        stages: { "rewrite-out": { rewritesAvailable: boolean } }
        result: Array<{ data?: string }>
        fidelity: { caveats: Array<string> }
      }
      expect(body.format).toBe("gemini")
      expect(body.stages["rewrite-out"].rewritesAvailable).toBe(false)
      // The dry-run uses an identity codec (not the real Gemini codec), so the render output is
      // the CC frame VERBATIM — the real CC→Gemini translation (B5: codec.renderResponse) is not
      // exercised here. The caveat must honestly flag the output is CC, not Gemini.
      expect(body.result[0]?.data).toBe(frame)
      expect(body.fidelity.caveats.some((c) => c.includes("CC 帧") && c.includes("非 Gemini"))).toBe(true)
    })

    test("request side: prepare-wire (S4-pre) derives the first-attempt wire under a throwaway betaProbe", async () => {
      // T4: stopAfter=prepare-wire runs the real `prepareAnthropicWire` (non-pure:
      // betaProbe.recordOutbound + ctx.recordFeature) — isolated by a throwaway probe +
      // the capturing manager, so no pollution. Verifies the wire + first-attempt note.
      const request = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }
      const res = await post({ request, stopAfter: "prepare-wire" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        format: string
        side: string
        inspection: { stoppedAt: string; stages: { "prepare-wire"?: { url?: string; body?: unknown; note?: string } } }
      }
      expect(body.format).toBe("anthropic")
      expect(body.side).toBe("request")
      expect(body.inspection.stoppedAt).toBe("prepare-wire")
      const pw = body.inspection.stages["prepare-wire"]
      expect(pw).toBeDefined()
      expect(typeof pw?.url).toBe("string")
      expect(pw?.body).toBeDefined()
      expect(pw?.note).toContain("first-attempt only")
    })

    test("rewrite-out vs render are both available; skipRender distinguishes the stop stage", async () => {
      // Anthropic identity-render: rewrite-out (skipRender) and render coincide, but the
      // fidelity note records which stop stage produced the output.
      const ev = (o: Record<string, unknown>): { raw: string; type: string } => ({ raw: JSON.stringify(o), type: o.type as string })
      const upstream = [
        ev({ type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-opus-4-8" } }),
        ev({ type: "message_stop" }),
      ]
      const ro = await post({ upstream: { sseEvents: upstream }, stopAfter: "rewrite-out" })
      const rd = await post({ upstream: { sseEvents: upstream }, stopAfter: "render" })
      const roBody = (await ro.json()) as { fidelity: { caveats: Array<string> } }
      const rdBody = (await rd.json()) as { fidelity: { caveats: Array<string> } }
      expect(roBody.fidelity.caveats.some((c) => c.includes("pre-render"))).toBe(true)
      expect(rdBody.fidelity.caveats.some((c) => c.includes("S6 render 后"))).toBe(true)
    })
  })
})

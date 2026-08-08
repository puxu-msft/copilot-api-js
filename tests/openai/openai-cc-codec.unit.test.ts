/**
 * P2.2 — openai-cc FormatCodec unit tests (pure / state-injected methods).
 *
 * Covers translateOut / prepareWire / renderResponse (incl. the
 * three loop-level behaviors the per-frame model must reproduce) /
 * renderResponseNonStreaming / formatError / createResponseAccumulator. `parse`
 * (needs the context-manager runtime) lives in the sibling `.it.test.ts`. Route decision
 * moved to the free-function `router.decideRoute` (ADR 2026-07-11) — covered by
 * tests/pipeline/router-golden.it.test.ts + route-matrix.it.test.ts.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  RequestEnvelope,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  UpstreamFrame,
} from "~/lib/pipeline/types"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { resolveCellAssembly } from "~/lib/pipeline/cell-assembly"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { autoRestoreState } from "../helpers/state-fixture"

// ── env stub (unit-level; parse builds the real one in the .it.test) ──────────

interface CtxStub {
  warningMessages: Array<{ code: string; message: string }>
  addWarningMessage: (w: { code: string; message: string }) => void
  recordFeature: (f: string) => void
  featuresRecorded: Array<string>
  toolNameMapper: ToolNameMapper | null
  setToolNameMapper: (mapper: ToolNameMapper | null) => void
}

function makeCtxStub(): CtxStub {
  const warningMessages: Array<{ code: string; message: string }> = []
  const featuresRecorded: Array<string> = []
  const stub: CtxStub = {
    warningMessages,
    addWarningMessage: (w) => warningMessages.push(w),
    recordFeature: (f) => featuresRecorded.push(f),
    featuresRecorded,
    toolNameMapper: null,
    setToolNameMapper: (mapper) => {
      stub.toolNameMapper = mapper
    },
  }
  return stub
}

function makeEnv(opts: { model?: Model; targetEndpoint?: UpstreamEndpoint; body?: unknown; ctx?: CtxStub }): RequestEnvelope {
  return {
    clientFormat: "openai-cc",
    targetEndpoint: opts.targetEndpoint ?? "/chat/completions",
    model: opts.model as unknown as RequestEnvelope["model"],
    stream: true,
    body: opts.body ?? { model: "gpt-4o", messages: [] },
    view: {} as RequestEnvelope["view"],
    prepareHints: {},
    ctx: (opts.ctx ?? makeCtxStub()) as unknown as RequestContext,
    with(patch) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as RequestEnvelope
}

function ccBody(over?: Partial<ChatCompletionsPayload>): ChatCompletionsPayload {
  return { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true, ...over }
}

function parseFrames(frames: Array<ClientFrame>): Array<Record<string, unknown>> {
  return frames.map((f) => JSON.parse(f.data ?? "") as Record<string, unknown>)
}

// The outbound methods (translateOut / prepareWire) moved off the codec onto the
// (clientFormat × targetEndpoint) CELL (RFC 2026-07-13 inbound/outbound split). These
// tests exercise the openai-cc cell for the env's targetEndpoint — the same object the
// driver dispatches through.
function outCell(env: RequestEnvelope) {
  return resolveCellAssembly("openai-cc", env.targetEndpoint)
}

// ── decideRoute ──────────────────────────────────────────────────────────────
// Route decision moved out of the codec into the free-function `router.decideRoute`
// (ADR 2026-07-11); its openai-cc coverage now lives in tests/pipeline/router-golden.it.test.ts
// + route-matrix.it.test.ts. No codec-level decideRoute tests remain here.

// ── translateOut ─────────────────────────────────────────────────────────────

describe("openai-cc cell — translateOut", () => {
  test("is identity (returns the same envelope reference)", () => {
    const env = makeEnv({})
    expect(outCell(env).translateOut(env)).toBe(env)
  })
})

// ── prepareWire ──────────────────────────────────────────────────────────────

describe("openai-cc cell — prepareWire", () => {
  autoRestoreState()

  test("/chat/completions: url=path, body=wire, stream from body; fills O10 max_completion_tokens", () => {
    setStateForTests({ copilotToken: "tok" })
    const model = mockModel("gpt-4o", { vendor: "OpenAI" })
    const env = makeEnv({ model, targetEndpoint: "/chat/completions", body: ccBody({ stream: false }) })

    const wire = outCell(env).prepareWire(env)
    expect(wire.url).toBe("/chat/completions")
    expect(wire.stream).toBe(false)
    expect(wire.headers.get("Authorization")).toBe("Bearer tok")
    const body = wire.body as ChatCompletionsPayload
    // O10: neither max_tokens nor max_completion_tokens set → filled from model limit
    expect(body.max_completion_tokens).toBe(4096)
  })

  test("/chat/completions: does NOT fill O10 when client already sent a token field", () => {
    setStateForTests({ copilotToken: "tok" })
    const model = mockModel("gpt-4o", { vendor: "OpenAI" })
    const env = makeEnv({ model, body: ccBody({ max_completion_tokens: 99 }) })
    const body = outCell(env).prepareWire(env).body as ChatCompletionsPayload
    expect(body.max_completion_tokens).toBe(99)
  })

  test("/responses: translates CC→Responses, url=/responses, records dropped params once", () => {
    setStateForTests({ copilotToken: "tok", normalizeResponsesCallIds: false })
    const model = mockModel("gpt-5", { supported_endpoints: ["/responses"] })
    const ctx = makeCtxStub()
    const env = makeEnv({ model, targetEndpoint: "/responses", ctx, body: ccBody({ seed: 7, stop: ["x"], stream: false }) })

    const cell = outCell(env)
    const wire = cell.prepareWire(env)
    expect(wire.url).toBe("/responses")
    // CC→Responses output has `input`, not `messages`
    expect((wire.body as { input?: unknown }).input).toBeDefined()
    expect(ctx.warningMessages).toHaveLength(1)
    expect(ctx.warningMessages[0]?.code).toBe("cc_to_responses_dropped_params")
    expect(ctx.warningMessages[0]?.message).toContain("seed")
    expect(ctx.featuresRecorded).toContain("dropped-params")

    // per-attempt idempotent: a second prepareWire does NOT duplicate the warning
    cell.prepareWire(env)
    expect(ctx.warningMessages).toHaveLength(1)
  })

  test("/responses: normalizeCallIds gated by state.normalizeResponsesCallIds", () => {
    setStateForTests({ copilotToken: "tok", normalizeResponsesCallIds: true })
    const model = mockModel("gpt-5", { supported_endpoints: ["/responses"] })
    const body = ccBody({
      stream: false,
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_abc", content: "ok" },
      ],
    })
    const env = makeEnv({ model, targetEndpoint: "/responses", body })
    const wire = outCell(env).prepareWire(env)
    const input = (wire.body as { input: Array<{ type?: string; call_id?: string; id?: string }> }).input
    // call_ → fc_ normalization applied
    const fnCall = input.find((i) => i.type === "function_call")
    expect(fnCall?.call_id?.startsWith("fc_")).toBe(true)
  })

  test("/responses streaming: wire.stream === true carried through the translation", () => {
    setStateForTests({ copilotToken: "tok", normalizeResponsesCallIds: false })
    const model = mockModel("gpt-5", { supported_endpoints: ["/responses"] })
    const env = makeEnv({ model, targetEndpoint: "/responses", body: ccBody({ stream: true }) })
    expect(outCell(env).prepareWire(env).stream).toBe(true)
  })
})

// ── renderResponse (passthrough) ─────────────────────────────────────────────

describe("openai-cc codec — renderResponse passthrough (/chat/completions)", () => {
  test("forwards the upstream CC frame verbatim (identity)", () => {
    const codec = createOpenAiCcCodec()
    const env = makeEnv({ targetEndpoint: "/chat/completions" })
    const frame: UpstreamFrame = { event: "message", data: '{"choices":[]}' }
    expect(codec.renderResponse(frame, env)).toBe(frame)
  })

  test("forwards an upstream [DONE] verbatim on passthrough", () => {
    const codec = createOpenAiCcCodec()
    const env = makeEnv({ targetEndpoint: "/chat/completions" })
    const frame: UpstreamFrame = { data: "[DONE]" }
    expect(codec.renderResponse(frame, env)).toBe(frame)
  })
})

// ── renderResponse (via-responses) — the 3 loop-level behaviors ──────────────

describe("openai-cc codec — renderResponse via-responses (/responses)", () => {
  function viaEnv(includeUsage = false): RequestEnvelope {
    return makeEnv({ targetEndpoint: "/responses", body: ccBody({ stream_options: { include_usage: includeUsage } }) })
  }

  test("unparseable data → [] (does not throw / tear the stream)", () => {
    const codec = createOpenAiCcCodec()
    expect(codec.renderResponse({ data: "not json {{{" }, viaEnv())).toEqual([])
  })

  test("upstream [DONE] / empty data → [] (sentinel swallowed)", () => {
    const codec = createOpenAiCcCodec()
    expect(codec.renderResponse({ data: "[DONE]" }, viaEnv())).toEqual([])
    expect(codec.renderResponse({ data: "" }, viaEnv())).toEqual([])
    expect(codec.renderResponse({}, viaEnv())).toEqual([])
  })

  test("response.created → one CC chunk with assistant role delta", () => {
    const codec = createOpenAiCcCodec()
    const out = codec.renderResponse({ data: JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-5" } }) }, viaEnv())
    const frames = Array.isArray(out) ? out : [out]
    const chunks = parseFrames(frames)
    expect(chunks).toHaveLength(1)
    expect((chunks[0] as { id: string }).id).toBe("resp_1")
    expect((chunks[0] as { choices: Array<{ delta: { role?: string } }> }).choices[0]?.delta.role).toBe("assistant")
  })

  test("response.completed → finish + usage chunks (always emitted), preserving order", () => {
    const codec = createOpenAiCcCodec()
    const env = viaEnv(true)
    // prime translator state with response id/model
    codec.renderResponse({ data: JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-5" } }) }, env)
    const out = codec.renderResponse(
      {
        data: JSON.stringify({
          type: "response.completed",
          response: { id: "resp_1", model: "gpt-5", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
        }),
      },
      env,
    )
    const frames = Array.isArray(out) ? out : [out]
    const chunks = parseFrames(frames)
    expect(chunks).toHaveLength(2)
    // first = finish chunk (finish_reason stop, no tool calls), second = usage chunk
    expect((chunks[0] as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason).toBe("stop")
    expect((chunks[1] as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens).toBe(10)
  })

  test("function_call across frames: output_item.added → tool_call chunk, then arguments.delta", () => {
    const codec = createOpenAiCcCodec()
    const env = viaEnv()
    const added = codec.renderResponse(
      {
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "search" },
        }),
      },
      env,
    )
    const addedChunks = parseFrames(Array.isArray(added) ? added : [added])
    expect(
      (addedChunks[0] as { choices: Array<{ delta: { tool_calls: Array<{ function: { name: string } }> } }> }).choices[0]?.delta.tool_calls[0]?.function.name,
    ).toBe("search")

    const argsDelta = codec.renderResponse({ data: JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"q":' }) }, env)
    const argChunks = parseFrames(Array.isArray(argsDelta) ? argsDelta : [argsDelta])
    expect(
      (argChunks[0] as { choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }> }).choices[0]?.delta.tool_calls[0]?.function
        .arguments,
    ).toBe('{"q":')
  })
})

// ── renderResponseNonStreaming ───────────────────────────────────────────────

describe("openai-cc codec — renderResponseNonStreaming", () => {
  test("passthrough (/chat/completions) → identity", () => {
    const codec = createOpenAiCcCodec()
    const env = makeEnv({ targetEndpoint: "/chat/completions" })
    const upstream = { id: "cc-1", choices: [] }
    expect(codec.renderResponseNonStreaming(upstream, env)).toBe(upstream)
  })

  test("via-responses (/responses) → translated to CC shape (object)", () => {
    const codec = createOpenAiCcCodec()
    const env = makeEnv({ targetEndpoint: "/responses" })
    const responsesResp = { id: "resp_1", model: "gpt-5", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const out = codec.renderResponseNonStreaming(responsesResp, env) as { object?: string }
    expect(out.object).toBe("chat.completion")
  })
})

// ── formatError ──────────────────────────────────────────────────────────────

describe("openai-cc codec — formatError", () => {
  test("idle-timeout → timeout_error", () => {
    const codec = createOpenAiCcCodec()
    const frame = codec.formatError("idle-timeout", makeEnv({}))
    expect(frame.event).toBe("error")
    const body = JSON.parse(frame.data ?? "") as { error: { message: string; type: string } }
    expect(body.error.type).toBe("timeout_error")
    expect(body.error.message).toBe("Stream idle timeout")
  })

  test("other → server_error", () => {
    const codec = createOpenAiCcCodec()
    const body = JSON.parse(codec.formatError("other", makeEnv({})).data ?? "") as { error: { type: string } }
    expect(body.error.type).toBe("server_error")
  })
})

// ── createResponseAccumulator ────────────────────────────────────────────────

describe("openai-cc codec — createResponseAccumulator", () => {
  test("returns a fresh OpenAI stream accumulator", () => {
    const codec = createOpenAiCcCodec()
    const acc = codec.createResponseAccumulator({ targetEndpoint: "/chat/completions" } as unknown as import("~/lib/pipeline/envelope").RequestEnvelope)
    expect(acc).toMatchObject({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" })
  })
})

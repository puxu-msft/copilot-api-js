/**
 * Debug API — pipeline dry-run (all formats, request + response side).
 *
 * `POST /api/debug/dry-run-pipeline` feeds a synthetic/replayed request context +
 * upstream response through the REAL v4 driver, short-circuits GHC, and emits the
 * selected stage's intermediate state — turning "wait for the symptom to recur"
 * into deterministic replay (motive: docs/rfc/pipeline-dry-run-inspector.md).
 *
 * Phase 3 (all formats):
 * - **Request side** (`stopAfter` ∈ parse/translate/rewrite-in): build the REAL
 *   per-format codec + driver, run `inspectRequest` under a capturing manager (so
 *   `codec.parse`'s `manager.create()` doesn't pollute history/WS). Anthropic
 *   mirrors its handler pre-step (`preprocessAnthropicMessages`) because that feeds
 *   the S3 request rewrites; CC/Responses/Gemini have NO request rewrites, so their
 *   rewrite-in is always empty and the handler's system-prompt pre-injection is not
 *   mirrored (caveat).
 * - **Response side** (`stopAfter` ∈ rewrite-out/render): feed the synthetic/replayed
 *   upstream through the driver's S5 rewrite chain. The response rewrites are real
 *   (Anthropic 4 / Responses 1 fixIds / CC + Gemini = none → `rewritesAvailable:false`);
 *   the render codec is a minimal identity shim, faithful because the driver's S6
 *   render IS identity for every format's direct/passthrough path (the non-identity
 *   work — Gemini's CC→Gemini whole-stream translation, Responses' post-render
 *   tool-name restore, Anthropic's heartbeat — is all handler-side, OUTSIDE the
 *   driver; see `fidelity.caveats` per format, RFC §10).
 *
 * `skipRender` (stopAfter=rewrite-out) yields the S5 frames verbatim; stopAfter=render
 * runs `codec.renderResponse` (S6). For identity-render direct-path inputs the two
 * coincide; the distinction is the inspector contract (T1).
 *
 * Config is always live (no configOverrides — RFC §6). Isolation: capturing manager
 * (request side) + no-publisher ctx (response side) → zero history/WS pollution.
 */

import type { Context } from "hono"

import { z } from "zod"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { RequestContext } from "~/lib/context/request"
import type { EndpointType } from "~/lib/history/types"
import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  ResponseRewrite,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  ClientFrame,
  FormatCodec,
  RawHttpRequest,
  RequestInspectStage,
  Transport,
  UpstreamFrame,
} from "~/lib/pipeline/types"
import type { GenerateContentRequest } from "~/types/api/gemini"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { ANTHROPIC_RESPONSE_REWRITES } from "~/lib/codec/anthropic/response-rewrites"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { createOpenAiGeminiCodec } from "~/lib/codec/openai-gemini/codec"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { RESPONSES_RESPONSE_REWRITES } from "~/lib/codec/openai-responses/response-rewrites"
import { withCapturingManager } from "~/lib/context/manager"
import { createRequestContext } from "~/lib/context/request"
import { convertGeminiRequestToOpenAI } from "~/lib/gemini"
import { getEntry } from "~/lib/history"
import { resolveModelName } from "~/lib/models/resolver"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { assembleResponseRewrites } from "~/lib/pipeline/rewrite-registry"

/** RFC-facing format names (the `format` param + the `entryId`→format mapping). */
type DryRunFormat = "anthropic" | "openai-cc" | "openai-responses" | "openai-gemini"

const REQUEST_STAGES = new Set<string>(["parse", "translate", "rewrite-in", "prepare-wire"])

/** entryId → format: the stored `endpoint` discriminant maps 1:1 to a dry-run format. */
const ENDPOINT_TO_FORMAT: Record<EndpointType, DryRunFormat> = {
  "anthropic-messages": "anthropic",
  "openai-chat-completions": "openai-cc",
  "openai-responses": "openai-responses",
  "gemini-generate-content": "openai-gemini",
}

/** Per-format response-side wiring: the env discriminants, the real S5 rewrites, and the handler-side fidelity gaps. */
interface ResponseFormatConfig {
  /** Internal `env.clientFormat` (note: the `openai-gemini` param maps to `"gemini"`). */
  clientFormat: ClientFormat
  /** Direct/passthrough target so the real rewrites' `appliesTo` + the identity render path match. */
  targetEndpoint: UpstreamEndpoint
  /** The real S5 response rewrites driving the chain (empty = CC/Gemini → rewritesAvailable:false). */
  responseRewrites: ReadonlyArray<ResponseRewrite>
  /** Handler-side work the driver output omits (RFC §10), surfaced in `fidelity.caveats`. */
  caveats: Array<string>
}

const RESPONSE_FORMAT_CONFIG: Record<DryRunFormat, ResponseFormatConfig> = {
  anthropic: {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    responseRewrites: ANTHROPIC_RESPONSE_REWRITES,
    caveats: ["缺 handler-side synthetic heartbeat 注入（anthropic.stream_fake_sse_heartbeat）"],
  },
  "openai-responses": {
    clientFormat: "openai-responses",
    targetEndpoint: "/responses",
    responseRewrites: RESPONSES_RESPONSE_REWRITES,
    caveats: ["缺 handler-side post-render tool-name restore（restoreResponsesStreamFrameToolNames/restoreResponsesOutputToolNames）"],
  },
  "openai-cc": {
    clientFormat: "openai-cc",
    targetEndpoint: "/chat/completions",
    responseRewrites: [],
    caveats: ["CC 响应侧无 driver 改写（rewritesAvailable:false）"],
  },
  "openai-gemini": {
    clientFormat: "gemini",
    // Gemini's upstream is CC (the request is translated Gemini→CC); the driver's render
    // normalizes upstream→CC and the CC→Gemini whole-stream translation is handler-side.
    targetEndpoint: "/chat/completions",
    responseRewrites: [],
    caveats: [
      "Gemini render 输出 CC 帧、非 Gemini（整流翻译 translateOpenAIStreamToGemini 在 driver 外，handler-side）",
      "Gemini 响应侧无 driver 改写（rewritesAvailable:false）",
    ],
  },
}

const InlineUpstreamSchema = z.union([
  z.object({ sseEvents: z.array(z.union([z.string(), z.object({ raw: z.string(), type: z.string().optional() })])) }),
  z.object({ response: z.record(z.string(), z.unknown()) }),
])

const DryRunPipelineSchema = z
  .object({
    /** Replay a stored history entry (uses its sseEvents/outboundResponse for response side, inboundRequest for request side). */
    entryId: z.string().min(1).optional(),
    /** Inline request payload (format-native body). Request-side stages read it; response-side reads only `tools`. */
    request: z.record(z.string(), z.unknown()).optional(),
    /** Inline synthetic upstream (streaming sseEvents or non-streaming response) — response side only. */
    upstream: InlineUpstreamSchema.optional(),
    /** Format. Derived from the entry's `endpoint` when `entryId` is given; defaults to `anthropic` for inline. */
    format: z.enum(["anthropic", "openai-cc", "openai-responses", "openai-gemini"]).optional(),
    /** Streaming vs non-streaming. Derived from entry/upstream when omitted. */
    stream: z.boolean().optional(),
    /** Stop stage. parse/translate/rewrite-in/prepare-wire = request side; rewrite-out/render = response side. */
    stopAfter: z.enum(["parse", "translate", "rewrite-in", "prepare-wire", "rewrite-out", "render"]).default("render"),
  })
  .refine((b) => b.entryId !== undefined || b.upstream !== undefined || b.request !== undefined, {
    message: "Provide either `entryId` or `upstream`",
  })

type DryRunBody = z.infer<typeof DryRunPipelineSchema>

/** A buffered async stream of UpstreamFrames from a concrete array. */
async function* framesOf(frames: ReadonlyArray<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const f of frames) yield f
}

/** Adapt history `SseEventRecord{raw,type}` (or inline string/{raw}) → driver `UpstreamFrame{data,event}`. */
function toUpstreamFrames(events: ReadonlyArray<unknown>): Array<UpstreamFrame> {
  return events.map((e) => {
    if (typeof e === "string") return { data: e } as UpstreamFrame
    const r = e as { raw?: string; data?: string; type?: string; event?: string }
    return { data: r.raw ?? r.data ?? "", event: r.type ?? r.event } as UpstreamFrame
  })
}

/**
 * Rebuild a full `AnthropicMessageResponse` from a stored entry's `outboundResponse`,
 * which history persists as the projection `{ role, content }` + scalar fields (NOT the
 * verbatim upstream message). Synthesized `id`/`stop_sequence` don't affect the
 * transformWhole chain (RFC §11 H1). Anthropic-only (the live non-streaming replay path).
 */
function rebuildNonStreamingResponse(outbound: Record<string, unknown>): AnthropicMessageResponse {
  const content = outbound.content as { content?: unknown } | undefined
  return {
    id: "dryrun_synthetic",
    type: "message",
    role: "assistant",
    content: (content?.content ?? outbound.content ?? []) as never,
    model: (outbound.model ?? "") as string,
    stop_reason: (outbound.stop_reason ?? null) as never,
    stop_sequence: null,
    usage: (outbound.usage ?? {}) as never,
  } as unknown as AnthropicMessageResponse
}

/** Minimal identity codec — only `renderResponse`/`renderResponseNonStreaming` (both identity) are reached by runResponse/runResponseWhole. */
function dryRunIdentityCodec(format: ClientFormat): FormatCodec {
  return {
    format,
    renderResponse: (frame: unknown) => frame,
    renderResponseNonStreaming: (upstream: unknown) => upstream,
  } as unknown as FormatCodec
}

const dryRunTransport: Transport = {
  send: () => {
    throw new Error("dry-run: transport is never used (S4 exchange is short-circuited)")
  },
} as unknown as Transport

/** Build the synthetic response-side env (no codec.parse → no global manager touch). */
function buildEnv(ctx: RequestContext, cfg: ResponseFormatConfig, tools: unknown, stream: boolean): RequestEnvelope {
  return {
    clientFormat: cfg.clientFormat,
    targetEndpoint: cfg.targetEndpoint,
    model: {},
    stream,
    body: { tools },
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

/** Resolve the dry-run format: explicit param > entry endpoint mapping > `anthropic` (inline default). */
function resolveFormat(body: DryRunBody, entryEndpoint?: EndpointType): DryRunFormat {
  if (body.format) return body.format
  if (entryEndpoint) return ENDPOINT_TO_FORMAT[entryEndpoint]
  return "anthropic"
}

/**
 * Build the REAL per-format codec + driver for the request side, then run `inspectRequest`
 * under a capturing manager (so `codec.parse`'s `manager.create()` doesn't pollute
 * history/WS). Anthropic mirrors its handler pre-step (`preprocessAnthropicMessages`),
 * which feeds the S3 request rewrites; the other formats have no request rewrites.
 */
function inspectFormatRequest(format: DryRunFormat, payload: Record<string, unknown>, stopAfter: RequestInspectStage) {
  if (format === "anthropic") {
    const pre = preprocessAnthropicMessages((payload.messages ?? []) as never)
    const betaProbe = createBetaProbe(typeof payload._anthropicBeta === "string" ? payload._anthropicBeta : undefined)
    const codec = createAnthropicCodec({
      betaProbe,
      preprocessInfo: { strippedReadTagCount: pre.strippedReadTagCount, dedupedToolCallCount: pre.dedupedToolCallCount },
    })
    const driver = createPipelineDriver({
      codec,
      transport: dryRunTransport,
      strategies: [],
      maxRetries: 0,
      maxLearningRetries: 0,
      requestRewrites: codec.getRequestRewrites(),
    })
    const raw = { body: { ...payload, messages: pre.messages }, headers: new Headers(), path: "/v1/messages", method: "POST" } as unknown as RawHttpRequest
    return withCapturingManager(() => driver.inspectRequest(raw, stopAfter))
  }

  const { codec, raw } = buildNonAnthropicRequest(format, payload)
  const driver = createPipelineDriver({ codec, transport: dryRunTransport, strategies: [], maxRetries: 0, maxLearningRetries: 0 })
  return withCapturingManager(() => driver.inspectRequest(raw, stopAfter))
}

/**
 * Build the CC / Responses / Gemini request-side codec + RawHttpRequest. CC/Responses parse
 * read `raw.body` as their native format directly; Gemini parse expects the ALREADY-translated
 * CC body as `raw.body` + the original Gemini snapshot as `originalBodyForHistory` (the route
 * translates Gemini→CC before parse), so we mirror that translation here (the handler's
 * system-prompt injection on the CC messages is NOT mirrored — caveat).
 */
function buildNonAnthropicRequest(format: Exclude<DryRunFormat, "anthropic">, payload: Record<string, unknown>): { codec: FormatCodec; raw: RawHttpRequest } {
  if (format === "openai-cc") {
    return {
      codec: createOpenAiCcCodec(),
      raw: { body: payload, headers: new Headers(), path: "/chat/completions", method: "POST" } as unknown as RawHttpRequest,
    }
  }
  if (format === "openai-responses") {
    return {
      codec: createOpenAiResponsesCodec(),
      raw: { body: payload, headers: new Headers(), path: "/responses", method: "POST" } as unknown as RawHttpRequest,
    }
  }
  // Gemini: model carried in the body for the dry-run (live path takes it from the URL).
  const modelId = typeof payload.model === "string" ? payload.model : ""
  const geminiBody = payload as unknown as GenerateContentRequest
  const { payload: ccPayload } = convertGeminiRequestToOpenAI(geminiBody, { model: resolveModelName(modelId), stream: false })
  const raw = {
    body: ccPayload,
    originalBodyForHistory: geminiBody,
    headers: new Headers(),
    path: `/v1beta/models/${modelId || "gemini"}:generateContent`,
    method: "POST",
  } as unknown as RawHttpRequest
  return { codec: createOpenAiGeminiCodec(modelId), raw }
}

function requestSideCaveats(format: DryRunFormat): Array<string> {
  const base =
    format === "anthropic" ?
      "请求侧 = 用当前代码 + live 配置重跑 inboundRequest，非复现当时（preprocess 会重算；betaProbe 为 throwaway；prepare-wire 仅首个 attempt、反应式 retry 改写不可见）"
    : `请求侧 = 用当前代码 + live 配置重跑 inboundRequest（非复现当时）；handler 的 system-prompt 预注入未镜像；model 重新解析（未用 route 的 preResolved）；${format} 无 S3 请求改写（rewrite-in 恒空）；反应式 retry 改写不可见${format === "openai-gemini" ? "；Gemini→CC 翻译按 stream=false" : ""}`
  return [base]
}

export async function handleDryRunPipeline(c: Context): Promise<Response> {
  const parsed = DryRunPipelineSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400)
  const body = parsed.data

  // ── Request side (S1→S3): real per-format codec + inspectRequest under a capturing manager ──
  if (REQUEST_STAGES.has(body.stopAfter)) {
    let payload: Record<string, unknown> | undefined = body.request
    let entryEndpoint: EndpointType | undefined
    if (body.entryId !== undefined) {
      const entry = getEntry(body.entryId)
      if (!entry) return c.json({ error: `History entry not found: ${body.entryId}` }, 404)
      entryEndpoint = entry.endpoint
      payload = entry.inboundRequest as Record<string, unknown> | undefined
    }
    if (!payload) return c.json({ error: "Request-side stages need `request` (inline payload) or `entryId`" }, 400)
    const format = resolveFormat(body, entryEndpoint)
    try {
      const { result: inspection, events } = inspectFormatRequest(format, payload, body.stopAfter as RequestInspectStage)
      return c.json({
        stopAfter: body.stopAfter,
        format,
        side: "request",
        inspection,
        diagnostics: { eventKinds: events.map((e) => e.kind) },
        fidelity: { clientFinal: false, caveats: requestSideCaveats(format) },
      })
    } catch (error) {
      return c.json({ error: `Dry-run request-side failed: ${error instanceof Error ? error.message : String(error)}` }, 400)
    }
  }

  // ── Response side (S5→S6): resolve format + input, feed the real S5 rewrite chain ──
  let entryEndpoint: EndpointType | undefined
  let tools: unknown
  let frames: Array<UpstreamFrame> | undefined
  let nonStreamingResponse: unknown

  if (body.entryId !== undefined) {
    const entry = getEntry(body.entryId)
    if (!entry) return c.json({ error: `History entry not found: ${body.entryId}` }, 404)
    entryEndpoint = entry.endpoint
    const inbound = entry.inboundRequest as { tools?: unknown } | undefined
    tools = inbound?.tools
    const sse = entry.sseEvents
    const isStream = body.stream ?? (Array.isArray(sse) && sse.length > 0)
    if (isStream) {
      if (!Array.isArray(sse) || sse.length === 0) return c.json({ error: "Entry has no sseEvents to replay (non-streaming? pass stream:false)" }, 400)
      frames = toUpstreamFrames(sse as Array<unknown>)
    } else {
      // Non-streaming replay rebuilds an Anthropic-shaped response from the projection —
      // Anthropic-only. Other formats' non-streaming entries can't be faithfully rebuilt
      // here (the projection differs per format), so reject rather than silently coerce a
      // CC/Responses/Gemini entry into an Anthropic envelope (review finding #3).
      if (entryEndpoint !== "anthropic-messages") {
        return c.json(
          {
            error: `Non-streaming entryId replay is only supported for Anthropic (endpoint=${entryEndpoint}); use inline \`upstream.response\` for other formats`,
          },
          400,
        )
      }
      const outbound = entry.outboundResponse as Record<string, unknown> | undefined
      if (!outbound) return c.json({ error: "Entry has no outboundResponse to replay" }, 400)
      nonStreamingResponse = rebuildNonStreamingResponse(outbound)
    }
  } else {
    tools = body.request?.tools
    const up = body.upstream
    if (up === undefined) return c.json({ error: "Provide either `entryId` or `upstream`" }, 400)
    if ("sseEvents" in up) frames = toUpstreamFrames(up.sseEvents)
    else nonStreamingResponse = up.response
  }

  const format = resolveFormat(body, entryEndpoint)
  const cfg = RESPONSE_FORMAT_CONFIG[format]
  const stream = frames !== undefined
  const skipRender = body.stopAfter === "rewrite-out"

  // ── Capturing ctx: real createRequestContext (no publisher → emit no-op) + recordFeature spy ──
  const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
  const ctx = createRequestContext({ endpoint: entryEndpoint ?? "anthropic-messages", path: "/api/debug/dry-run-pipeline", method: "POST" })
  const realRecordFeature = ctx.recordFeature.bind(ctx)
  ;(ctx as { recordFeature: RequestContext["recordFeature"] }).recordFeature = (feature, detail) => {
    features.push({ feature, ...(detail !== undefined && { detail }) })
    realRecordFeature(feature, detail)
  }

  const env = buildEnv(ctx, cfg, tools, stream)
  // Honest `rewritesAvailable` (review #1/#2): derive from rewrites that ACTUALLY assemble
  // for THIS env+config (gate-aware via `appliesTo`), not the static registry length. A
  // Responses dry-run with `fixResponsesStreamIds:false` assembles to `[]` → false (not a
  // phantom true). Per path: streaming runs `transform` (every ResponseRewrite has one);
  // non-streaming runs `transformWhole` (a streaming-only rewrite like fixIds has none →
  // structurally inert in the whole-response chain → false).
  const assembled = assembleResponseRewrites(env, cfg.responseRewrites)
  const rewritesAvailable = stream ? assembled.length > 0 : assembled.some((r) => r.transformWhole !== undefined)
  const driver = createPipelineDriver({
    codec: dryRunIdentityCodec(cfg.clientFormat),
    transport: dryRunTransport,
    strategies: [],
    maxRetries: 0,
    maxLearningRetries: 0,
    responseRewrites: cfg.responseRewrites,
  })

  const fidelity = {
    clientFinal: false,
    caveats: [
      ...cfg.caveats,
      `driver 输出 ≠ 客户端实收（缺上述 handler-side 后处理）；stopAfter=${body.stopAfter}${skipRender ? "（S5 帧，pre-render）" : "（S6 render 后）"}`,
      "配置为当前 live 值；若与回放 entry 当时不同，结果不代表当时客户端实收",
    ],
  }

  try {
    if (frames !== undefined) {
      const upstreamRaw = frames.map((f) => ({ data: f.data, event: f.event }))
      // Sample each rewrite's per-frame action (T2) → grouped perRewrite frameActions (RFC §3).
      const perRewriteMap = new Map<string, Array<{ frameIndex: number; action: FrameAction["kind"]; outputFrameCount: number }>>()
      const onRewriteAction = (name: string, frameIndex: number, action: FrameAction): void => {
        const list = perRewriteMap.get(name) ?? []
        list.push({ frameIndex, action: action.kind, outputFrameCount: action.kind === "emit" ? action.frames.length : 0 })
        perRewriteMap.set(name, list)
      }
      const forwarded: Array<ClientFrame> = []
      for await (const f of driver.runResponse({ frames: framesOf(frames) } as never, env, { skipRender, onRewriteAction })) forwarded.push(f)
      const perRewrite = [...perRewriteMap].map(([name, frameActions]) => ({ name, frameActions }))
      return c.json({
        stopAfter: body.stopAfter,
        format,
        stream: true,
        fidelity,
        stages: { "rewrite-out": { rewritesAvailable, perRewrite } },
        result: forwarded.map((f) => ({ data: f.data, event: f.event })),
        diagnostics: { features },
        upstreamRaw,
      })
    }

    // Non-streaming: the transformWhole chain expects `content` as a block array (Anthropic
    // shape). A replayed entry/inline response whose content isn't a block array is a
    // data-shape mismatch, not a code bug — surface a clear 400 rather than an opaque throw.
    if (!Array.isArray((nonStreamingResponse as { content?: unknown } | undefined)?.content)) {
      return c.json({ error: "Non-streaming response `content` must be a block array (replayed entry/inline response shape not supported)" }, 400)
    }
    const result = driver.runResponseWhole(nonStreamingResponse, env)
    return c.json({
      stopAfter: body.stopAfter,
      format,
      stream: false,
      fidelity,
      stages: { "rewrite-out": { rewritesAvailable, perRewrite: [] } },
      result,
      diagnostics: { features },
      upstreamRaw: nonStreamingResponse,
    })
  } catch (error) {
    return c.json({ error: `Dry-run failed: ${error instanceof Error ? error.message : String(error)}`, diagnostics: { features } }, 400)
  }
}

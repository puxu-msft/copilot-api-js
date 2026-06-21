/**
 * Debug API — pipeline dry-run (response side, Anthropic).
 *
 * `POST /api/debug/dry-run-pipeline` 把合成/回放的上游响应喂进真实 v4 driver 的
 * S5 响应改写链（recover/thinking/decode/filter，`ANTHROPIC_RESPONSE_REWRITES`），
 * 短路 GHC，输出 forwarded 帧 + 捕获的 feature 事件，使"上游某响应经当前代码处理后
 * 客户端会收到什么"可确定性观测（动机见 docs/rfc/pipeline-dry-run-inspector.md）。
 *
 * Phase 1 范围（响应侧 Anthropic，零全局 swap）：
 * - 手工构造 `RequestEnvelope`（不跑 codec.parse → 不碰全局 manager），ctx 用
 *   `createRequestContext`（无 publisher → emit 全 no-op）+ wrap `recordFeature` 捕获。
 * - Anthropic `renderResponse` 是 identity，故 `stopAfter` rewrite-out/render 等价，
 *   无需 driver 改动。
 * - 配置一律 live（不做 configOverrides，见 RFC §6）。
 *
 * 保真边界（RFC §10）：driver 输出 ≠ 客户端实收——缺 handler-side 的 synthetic
 * heartbeat 注入。本案 decode/backfill 是 driver-side 改写，对本案够用。
 */

import type { Context } from "hono"

import { z } from "zod"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  FormatCodec,
  RawHttpRequest,
  RequestInspectStage,
  Transport,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { ANTHROPIC_RESPONSE_REWRITES } from "~/lib/codec/anthropic/response-rewrites"
import { withCapturingManager } from "~/lib/context/manager"
import { createRequestContext } from "~/lib/context/request"
import { getEntry } from "~/lib/history"
import { createPipelineDriver } from "~/lib/pipeline/driver"

const REQUEST_STAGES = new Set<string>(["parse", "translate", "rewrite-in"])

const InlineUpstreamSchema = z.union([
  z.object({ sseEvents: z.array(z.union([z.string(), z.object({ raw: z.string(), type: z.string().optional() })])) }),
  z.object({ response: z.record(z.string(), z.unknown()) }),
])

const DryRunPipelineSchema = z
  .object({
    /** Replay a stored history entry (uses its sseEvents/outboundResponse for response side, inboundRequest for request side). */
    entryId: z.string().min(1).optional(),
    /** Inline request payload (full Anthropic body). Request-side stages read it; response-side reads only `tools`. */
    request: z.record(z.string(), z.unknown()).optional(),
    /** Inline synthetic upstream (streaming sseEvents or non-streaming response) — response side only. */
    upstream: InlineUpstreamSchema.optional(),
    /** Streaming vs non-streaming. Derived from entry/upstream when omitted. */
    stream: z.boolean().optional(),
    /** Stop stage. parse/translate/rewrite-in = request side; rewrite-out/render = response side (Anthropic render is identity). */
    stopAfter: z.enum(["parse", "translate", "rewrite-in", "rewrite-out", "render"]).default("render"),
  })
  .refine((b) => b.entryId !== undefined || b.upstream !== undefined || b.request !== undefined, {
    message: "Provide either `entryId` or `upstream`",
  })

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
 * transformWhole chain (RFC §11 H1).
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

/** Minimal Anthropic codec — only `renderResponse`/`renderResponseNonStreaming` (both identity) are reached by runResponse/runResponseWhole. */
function dryRunAnthropicCodec(): FormatCodec {
  return {
    format: "anthropic",
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
function buildEnv(ctx: RequestContext, tools: unknown, stream: boolean): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
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

/**
 * Request-side inspection (S1→`stopAfter`): assemble the REAL Anthropic codec (per-request closure
 * over a throwaway betaProbe + freshly-computed preprocessInfo) + driver, then run `inspectRequest`
 * under a capturing manager (so `codec.parse`'s `manager.create()` doesn't pollute history/WS).
 * Mirrors the handler's pre-step (`preprocessAnthropicMessages`); fidelity caveats in the response.
 */
function inspectAnthropicRequest(payload: Record<string, unknown>, stopAfter: RequestInspectStage) {
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

export async function handleDryRunPipeline(c: Context): Promise<Response> {
  const parsed = DryRunPipelineSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400)
  const body = parsed.data

  // ── Request side (S1→S3): build the real Anthropic codec + inspectRequest under a capturing manager ──
  if (REQUEST_STAGES.has(body.stopAfter)) {
    let payload: Record<string, unknown> | undefined = body.request
    if (body.entryId !== undefined) {
      const entry = getEntry(body.entryId)
      if (!entry) return c.json({ error: `History entry not found: ${body.entryId}` }, 404)
      payload = entry.inboundRequest as Record<string, unknown> | undefined
    }
    if (!payload) return c.json({ error: "Request-side stages need `request` (inline payload) or `entryId`" }, 400)
    const { result: inspection, events } = inspectAnthropicRequest(payload, body.stopAfter as RequestInspectStage)
    return c.json({
      stopAfter: body.stopAfter,
      format: "anthropic",
      side: "request",
      inspection,
      diagnostics: { eventKinds: events.map((e) => e.kind) },
      fidelity: {
        clientFinal: false,
        caveats: [
          "请求侧 = 用当前代码 + live 配置重跑 inboundRequest，非复现当时（preprocess 会重算；betaProbe 为 throwaway；反应式 retry 改写不可见，prepare-wire 未含本 MVP）",
        ],
      },
    })
  }

  // ── Resolve input: tools (for recover schema), streaming frames OR non-streaming response ──
  let tools: unknown
  let frames: Array<UpstreamFrame> | undefined
  let nonStreamingResponse: AnthropicMessageResponse | undefined

  if (body.entryId !== undefined) {
    const entry = getEntry(body.entryId)
    if (!entry) return c.json({ error: `History entry not found: ${body.entryId}` }, 404)
    const inbound = entry.inboundRequest as { tools?: unknown } | undefined
    tools = inbound?.tools
    const sse = entry.sseEvents
    const isStream = body.stream ?? (Array.isArray(sse) && sse.length > 0)
    if (isStream) {
      if (!Array.isArray(sse) || sse.length === 0) return c.json({ error: "Entry has no sseEvents to replay (non-streaming? pass stream:false)" }, 400)
      frames = toUpstreamFrames(sse as Array<unknown>)
    } else {
      const outbound = entry.outboundResponse as Record<string, unknown> | undefined
      if (!outbound) return c.json({ error: "Entry has no outboundResponse to replay" }, 400)
      nonStreamingResponse = rebuildNonStreamingResponse(outbound)
    }
  } else {
    tools = body.request?.tools
    const up = body.upstream
    if (up === undefined) return c.json({ error: "Provide either `entryId` or `upstream`" }, 400)
    if ("sseEvents" in up) frames = toUpstreamFrames(up.sseEvents)
    else nonStreamingResponse = up.response as unknown as AnthropicMessageResponse
  }

  const stream = frames !== undefined

  // ── Capturing ctx: real createRequestContext (no publisher → emit no-op) + recordFeature spy ──
  const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
  const ctx = createRequestContext({ endpoint: "anthropic-messages", path: "/api/debug/dry-run-pipeline", method: "POST" })
  const realRecordFeature = ctx.recordFeature.bind(ctx)
  ;(ctx as { recordFeature: RequestContext["recordFeature"] }).recordFeature = (feature, detail) => {
    features.push({ feature, ...(detail !== undefined && { detail }) })
    realRecordFeature(feature, detail)
  }

  const env = buildEnv(ctx, tools, stream)
  const driver = createPipelineDriver({
    codec: dryRunAnthropicCodec(),
    transport: dryRunTransport,
    strategies: [],
    maxRetries: 0,
    maxLearningRetries: 0,
    responseRewrites: ANTHROPIC_RESPONSE_REWRITES,
  })

  const fidelity = {
    clientFinal: false,
    caveats: [
      "driver 输出 ≠ 客户端实收：缺 handler-side synthetic heartbeat 注入（anthropic.fake_sse_heartbeat）",
      "配置为当前 live 值；若与回放 entry 当时不同，结果不代表当时客户端实收",
    ],
  }

  try {
    if (frames !== undefined) {
      const upstreamRaw = frames.map((f) => ({ data: f.data, event: f.event }))
      const forwarded: Array<ClientFrame> = []
      for await (const f of driver.runResponse({ frames: framesOf(frames) } as never, env)) forwarded.push(f)
      return c.json({
        stopAfter: body.stopAfter,
        format: "anthropic",
        stream: true,
        fidelity,
        result: forwarded.map((f) => ({ data: f.data, event: f.event })),
        diagnostics: { features },
        upstreamRaw,
      })
    }
    // Non-streaming: the transformWhole chain expects `content` as a block array. A replayed
    // entry whose `content` is a string/null (or a malformed inline response) is a data-shape
    // mismatch, not a code bug — surface it as a clear 400 rather than an opaque chain throw.
    if (!Array.isArray((nonStreamingResponse as { content?: unknown } | undefined)?.content)) {
      return c.json({ error: "Non-streaming response `content` must be a block array (replayed entry/inline response shape not supported)" }, 400)
    }
    const result = driver.runResponseWhole(nonStreamingResponse, env)
    return c.json({
      stopAfter: body.stopAfter,
      format: "anthropic",
      stream: false,
      fidelity,
      result,
      diagnostics: { features },
      upstreamRaw: nonStreamingResponse,
    })
  } catch (error) {
    return c.json({ error: `Dry-run failed: ${error instanceof Error ? error.message : String(error)}`, diagnostics: { features } }, 400)
  }
}

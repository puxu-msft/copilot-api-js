/**
 * The direct Anthropic `/v1/messages` LEG algorithm cores, extracted VERBATIM from the anthropic codec
 * (C2a of the CellAssembly refactor, RFC 2026-07-13 §11). These are the wire-prep / pre-send / sampling
 * primitives the direct `/v1/messages` outbound leg needs — already near-pure over `(env[, wire], deps)`,
 * so the extraction is byte-for-byte identical (the C0 direct-stream golden locks it).
 *
 * WHY a shared module: both the anthropic codec (transitionally, until C2a's driver fork routes the
 * direct cell through `AnthropicCellAssembly`) and the `OUTBOUND_LEGS[/v1/messages]` assembly call the
 * SAME functions — zero byte divergence. `anthropicPreSend` / `sampleAnthropicRequest` were ALREADY pure
 * (`env`-only); `prepareAnthropicWire` takes an explicit {@link PrepareWireDeps} the caller sources from
 * the codec closure today and from `env.requestState` + `env.ctx` under the assembly.
 */


import type { RequestContext } from "~/lib/context/request"
import type {
  //
  EffectiveRequest,
  WireRequest,
} from "~/lib/context/types"
import type { EndpointType } from "~/lib/history/types"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  RequestSample,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { type BetaProbe } from "~/lib/anthropic/pipeline"
import { prepareAnthropicRequest } from "~/lib/anthropic/request-preparation"
import { sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import { ENDPOINT } from "~/lib/models/endpoint"

const ENDPOINT_TYPE: EndpointType = "anthropic-messages"

// ============================================================================
// S4 — prepareWire
// ============================================================================

export interface PrepareWireDeps {
  betaProbe: BetaProbe
  clientAnthropicBeta: string | undefined
  /** Client's raw inbound headers (lowercased) for optional upstream passthrough. */
  clientRequestHeaders: Record<string, string> | undefined
  requestContext: RequestContext | undefined
  /**
   * Client's original `thinking.type` (fixed across retries — from the truncate
   * baseline, NOT `env.body` which retries mutate). Recorded as the `requested`
   * half of the merged `thinking` feature alongside the effective wire value.
   */
  requestedThinkingType: string | undefined
}

/**
 * S4 last-mile: env → wire via `prepareAnthropicRequest` (B1-B12 — wire payload +
 * reject/server-tool strip + coerce-thinking + clamp-effort + cache-control +
 * headers). Records the outbound betas on the probe (replacing the legacy adapter's
 * `onPrepared`) + surfaces the actual wire `thinking` shape as a feature.
 *
 * Idempotent (RFC §3): `prepareAnthropicRequest` deep-clones and does not write
 * back to `env.body`, so the same env → the same wire.
 */
export function prepareAnthropicWire(env: RequestEnvelope, deps: PrepareWireDeps): PreparedRequest & { strippedCacheControlSubfields?: ReadonlyArray<string> } {
  const model = env.model as Model | undefined
  const prepared = prepareAnthropicRequest(env.body as MessagesPayload, {
    ...(model && { resolvedModel: model }),
    ...(deps.clientAnthropicBeta !== undefined && { clientAnthropicBeta: deps.clientAnthropicBeta }),
    ...(deps.clientRequestHeaders !== undefined && { clientRequestHeaders: deps.clientRequestHeaders }),
    ...(env.prepareHints.excludeBetas && { excludeBetas: env.prepareHints.excludeBetas }),
    ...(env.prepareHints.rejectFields && { rejectFields: env.prepareHints.rejectFields }),
    ...(env.prepareHints.excludeServerToolTypes && { excludeServerToolTypes: env.prepareHints.excludeServerToolTypes }),
    ...(env.prepareHints.excludeToolFields && { excludeToolFields: env.prepareHints.excludeToolFields }),
    ...(env.prepareHints.excludeCacheControlSubfields && { excludeCacheControlSubfields: env.prepareHints.excludeCacheControlSubfields }),
    ...(env.prepareHints.contextEscalation && { contextEscalation: env.prepareHints.contextEscalation }),
  })

  // Record the betas actually sent (sanitized headers — same value the legacy
  // adapter's onPrepared received) so unsupported-beta can probe them.
  deps.betaProbe.recordOutbound(sanitizeHeadersForHistory(prepared.headers))

  // Record `thinking` as a per-request terminal dimension: `effective` = the
  // ACTUAL outbound wire shape (post coerceAdaptiveThinking), `requested` = the
  // client's original type (fixed baseline, supplied by the codec). The console
  // overwrites `effective` per attempt and renders requested→effective once, so
  // a coercion stays visible even when a retry rewrites the body.
  const wireThinking = prepared.wire.thinking as { type?: string } | undefined
  if (wireThinking?.type && wireThinking.type !== "disabled") {
    deps.requestContext?.recordFeature("thinking", {
      ...(deps.requestedThinkingType !== undefined && { requested: deps.requestedThinkingType }),
      effective: wireThinking.type,
    })
  }

  // passthrough 剥掉 GHC 未支持的 cache_control 子字段（如 scope）——记 live TUI/WS 看板（cc-strip:<fields>）。
  // 持久化（pipelineInfo.cacheControlStripped）经返回值 `strippedCacheControlSubfields` 上抛 → anthropic-cell
  // 的 sampleWireTrack 写 `ctx.setAttemptCacheControlStripped` → handler 读 `ctx.currentAttempt.cacheControlStripped`（spec §8 双通道）。
  if (prepared.strippedCacheControlSubfields?.length) {
    deps.requestContext?.recordFeature("cache-control-stripped", { fields: prepared.strippedCacheControlSubfields })
  }

  return {
    url: ENDPOINT.MESSAGES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: (prepared.wire.stream as boolean | undefined) ?? false,
    ...(prepared.strippedCacheControlSubfields?.length && { strippedCacheControlSubfields: prepared.strippedCacheControlSubfields }),
  }
}

/**
 * S4 last-mile for a REVERSE `@messages` leg (cc/responses/gemini client → Anthropic wire): the body is
 * already Anthropic-shaped (the leg's translateOut delegated to the hub), so build the Anthropic wire via
 * `prepareAnthropicRequest` (B1-B12). Distinct from {@link prepareAnthropicWire}: NO client anthropic-beta /
 * client headers / thinking+cache-control ctx side-channels (a non-Anthropic client sends none, and the
 * reverse leg does not record the direct-only pipeline diagnostics). The handler-injected `betaProbe`
 * records the outbound betas so the reverse unsupported-beta strategy can probe them.
 *
 * Extracted VERBATIM (C2b) from the openai-cc + openai-responses codecs, where it was DUPLICATED — one
 * shared definition both codecs and the `OUTBOUND_LEGS[/v1/messages]` reverse branch call (zero divergence).
 */
export function prepareReverseAnthropicWire(env: RequestEnvelope, betaProbe: BetaProbe | undefined): PreparedRequest {
  const model = env.model as Model | undefined
  const prepared = prepareAnthropicRequest(env.body as MessagesPayload, {
    ...(model && { resolvedModel: model }),
    ...(env.prepareHints.excludeBetas && { excludeBetas: env.prepareHints.excludeBetas }),
    ...(env.prepareHints.rejectFields && { rejectFields: env.prepareHints.rejectFields }),
    ...(env.prepareHints.excludeServerToolTypes && { excludeServerToolTypes: env.prepareHints.excludeServerToolTypes }),
    ...(env.prepareHints.excludeToolFields && { excludeToolFields: env.prepareHints.excludeToolFields }),
    ...(env.prepareHints.excludeCacheControlSubfields && { excludeCacheControlSubfields: env.prepareHints.excludeCacheControlSubfields }),
    ...(env.prepareHints.contextEscalation && { contextEscalation: env.prepareHints.contextEscalation }),
  })
  // Record the outbound betas so the reverse unsupported-beta strategy can probe them (mirrors the
  // anthropic codec's prepareWire recordOutbound — the SAME probe instance the handler injects here).
  betaProbe?.recordOutbound(sanitizeHeadersForHistory(prepared.headers))
  return {
    url: ENDPOINT.MESSAGES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: (prepared.wire.stream as boolean | undefined) ?? false,
  }
}

// ============================================================================
// S4 — sampleRequest (two-track observability)
// ============================================================================

export interface SampleAnthropicResult {
  requestSample: RequestSample
  effectiveMessages: Array<unknown>
}

/**
 * S4 observability (P2.3-S): the two history tracks. Both are `anthropic-messages`
 * format (translateOut is identity, so env.body stays Anthropic-shaped):
 *   - `effective` = the post-rewrite logical request (`env.body`).
 *   - `wire` = the actual outbound bytes (`prepared.wire`, B1-B12 + sanitized headers).
 *
 * Captures the latest effective `messages` for the route to rebuild retry
 * message-mapping (RFC §12.4/§12.5). The §12.5 invariant
 * (`action.env.body === action.payload`) makes these the same objects the legacy
 * `recordRetryPipelineState` reads from `newPayload`.
 */
export function sampleAnthropicRequest(wire: PreparedRequest, env: RequestEnvelope): SampleAnthropicResult {
  const effBody = env.body as MessagesPayload
  const effectiveMessages: Array<unknown> = Array.isArray(effBody.messages) ? effBody.messages : []

  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: effectiveMessages,
    payload: env.body,
    format: ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; messages?: unknown }
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: Array.isArray(wireBody.messages) ? wireBody.messages : [],
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: ENDPOINT_TYPE,
  }

  return { requestSample: { effective, wire: wireRequest }, effectiveMessages }
}

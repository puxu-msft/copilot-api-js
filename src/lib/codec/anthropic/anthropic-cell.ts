/**
 * The `/v1/messages` OUTBOUND leg (Anthropic wire) for the CellAssembly refactor (RFC 2026-07-13 §11).
 *
 * Fills `OUTBOUND_LEGS[ENDPOINT.MESSAGES]`. The leg's methods dispatch on `env.clientFormat`:
 *   - `anthropic` (DIRECT `/v1/messages`) — C2a: implemented here, reusing the SAME `anthropic-leg`
 *     cores + `buildAnthropicStrategies` + sanitize/quarantine rewrites the codec calls, so the driver's
 *     cell-keyed fork is byte-for-byte identical (the C0 direct-stream golden locks it). Request-lifecycle-
 *     stable supply is read from `env.requestState`; side-channels are written to `env.ctx`.
 *   - `openai-cc` / `gemini` / `openai-responses` (REVERSE `@messages`) — C2b: still throw here (the
 *     driver fork only routes the migrated `anthropic|/v1/messages` cell, so these are unreachable until
 *     C2b registers the reverse cells + supplies the reverse translateOut + resanitize).
 */

import type { AnthropicSanitizeFn } from "~/lib/anthropic/pipeline"
import type { Model } from "~/lib/models/client"
import type {
  //
  OutboundLeg,
  RetrySemanticsSpec,
} from "~/lib/pipeline/cell-assembly"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RequestRewrite,
  ResponseRewrite,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  PreparedRequest,
  RequestSample,
  RetryStrategy,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createQuarantineProactiveFilter } from "~/lib/anthropic/thinking-quarantine/proactive-filter"
import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { state } from "~/lib/state"

import {
  //
  anthropicPreSend,
  prepareAnthropicWire,
  sampleAnthropicRequest,
} from "./anthropic-leg"
import { createAnthropicSanitizeRewrite } from "./request-rewrite-adapter"
import { buildAnthropicStrategies } from "./strategies"

/** Guard for the not-yet-migrated reverse cells (C2b) — a loud, identifiable error (never a silent wrong-wire). */
function reverseNotMigrated(env: RequestEnvelope): never {
  throw new Error(`[anthropic-cell] reverse @messages leg for clientFormat "${env.clientFormat}" has not migrated yet (C2b)`)
}

/** The direct-Anthropic PrepareWireDeps sourced from `env.requestState` + `env.ctx` (RFC §11.2 carriers). */
function directWireDeps(env: RequestEnvelope): Parameters<typeof prepareAnthropicWire>[1] {
  const rs = env.requestState
  const baseline = rs?.truncateBaseline as MessagesPayload | undefined
  return {
    // The betaProbe is the SHARED mutable instance parse put on requestState (R3 — reference sharing +
    // lazy read; the throw below only fires on a wiring bug where parse did not populate it).
    betaProbe: rs?.betaProbe ?? throwMissing("betaProbe"),
    clientAnthropicBeta: rs?.clientAnthropicBeta,
    clientRequestHeaders: rs?.clientRequestHeaders,
    requestContext: env.ctx,
    // requested = the client's original thinking type, from the FIXED truncate baseline (never per-attempt env.body).
    requestedThinkingType: (baseline?.thinking as { type?: string } | undefined)?.type,
  }
}

function throwMissing(field: string): never {
  throw new Error(`[anthropic-cell] env.requestState.${field} missing — anthropic parse did not populate the leg supply`)
}

/** The `/v1/messages` outbound leg. Anthropic direct is wired (C2a); reverse cells throw until C2b. */
export const anthropicMessagesLeg: OutboundLeg = {
  targetEndpoint: ENDPOINT.MESSAGES,

  // S2: direct `/v1/messages` is identity (the upstream IS the Anthropic Messages API); reverse legs
  // translate source→Anthropic (C2b).
  translateOut(env) {
    if (env.clientFormat === "anthropic") return env
    return reverseNotMigrated(env)
  },

  // S3: the direct Anthropic sanitize chain (quarantine + sanitize). preprocessInfo comes from
  // env.requestState (parse-supplied); the sanitize rewrite writes its side-channels to env.ctx itself
  // (initialSanitizationInfo + gated pipelineInfo), so the onInitialSanitizationInfo callback is a no-op here.
  requestRewrites(env): ReadonlyArray<RequestRewrite> {
    if (env.clientFormat !== "anthropic") return reverseNotMigrated(env)
    const preprocessInfo = env.requestState?.preprocessInfo ?? throwMissing("preprocessInfo")
    return [createQuarantineProactiveFilter(), createAnthropicSanitizeRewrite({ preprocessInfo, onInitialSanitizationInfo: () => {} })]
  },

  prepareWire(env): PreparedRequest {
    if (env.clientFormat !== "anthropic") return reverseNotMigrated(env)
    return prepareAnthropicWire(env, directWireDeps(env))
  },

  responseRewrites(env): ReadonlyArray<ResponseRewrite> {
    if (env.clientFormat !== "anthropic") return reverseNotMigrated(env)
    // The driver's assembleResponseRewrites filters this full union to the /v1/messages subset via each
    // rewrite's targetEndpoint-keyed appliesTo — the same array the messages handler passed as deps.
    return ALL_RESPONSE_REWRITES
  },

  preSend(env): Promise<RequestEnvelope> {
    if (env.clientFormat !== "anthropic") return Promise.reject(new Error(`[anthropic-cell] reverse preSend not migrated (C2b): ${env.clientFormat}`))
    return anthropicPreSend(env)
  },

  sampleWireTrack(wire, env): RequestSample {
    if (env.clientFormat !== "anthropic") return reverseNotMigrated(env)
    const sample = sampleAnthropicRequest(wire, env)
    // Record this attempt's stripped cache_control subfields on the ctx attempt (the wire carries them
    // from prepareAnthropicWire) — the retry pipeline-info rebuild reads ctx.currentAttempt.cacheControlStripped.
    const stripped = (wire as { strippedCacheControlSubfields?: ReadonlyArray<string> }).strippedCacheControlSubfields
    if (stripped?.length) env.ctx.setAttemptCacheControlStripped(stripped)
    return sample.requestSample
  },

  buildLegStrategies(spec: RetrySemanticsSpec, env): ReadonlyArray<RetryStrategy> {
    if (env.clientFormat !== "anthropic") return reverseNotMigrated(env)
    const rs = env.requestState
    return buildAnthropicStrategies({
      originalPayload: (rs?.truncateBaseline as MessagesPayload | undefined) ?? (env.body as MessagesPayload),
      resanitize: rs?.resanitize as AnthropicSanitizeFn,
      model: env.model as Model | undefined,
      maxRetries: spec.maxRetries,
      betaProbe: rs?.betaProbe ?? throwMissing("betaProbe"),
    })
  },
}

/** RETRY_SEMANTICS for the anthropic client on the /v1/messages leg — auto-truncate in the stack, N retries. */
export function anthropicMessagesRetrySemantics(): RetrySemanticsSpec {
  return { autoTruncate: true, maxRetries: state.autoTruncateMaxRetries, label: "Anthropic" }
}

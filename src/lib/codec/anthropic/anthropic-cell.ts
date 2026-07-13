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
import {
  //
  type ReverseAnthropicMapperHolder,
  buildReverseResanitize,
  createReverseAnthropicSanitizeRewrite,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { translateRequestVia } from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"

import {
  //
  anthropicPreSend,
  prepareAnthropicWire,
  prepareReverseAnthropicWire,
  sampleAnthropicRequest,
} from "./anthropic-leg"
import { createAnthropicSanitizeRewrite } from "./request-rewrite-adapter"
import { buildAnthropicStrategies } from "./strategies"

/** Is this a REVERSE `@messages` cell (a non-anthropic client translated to the Anthropic wire)? */
function isReverse(env: RequestEnvelope): boolean {
  return env.clientFormat !== "anthropic"
}

/** The reverse leg's shared per-request mapper holder (parse put it on requestState; both sanitize + resanitize read it). */
function reverseMapperHolder(env: RequestEnvelope): ReverseAnthropicMapperHolder {
  return (env.requestState?.reverseMapperHolder as ReverseAnthropicMapperHolder | undefined) ?? throwMissing("reverseMapperHolder")
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

/** The `/v1/messages` outbound leg — anthropic DIRECT (C2a) + the 3 REVERSE `@messages` cells (C2b). */
export const anthropicMessagesLeg: OutboundLeg = {
  targetEndpoint: ENDPOINT.MESSAGES,

  // S2: direct `/v1/messages` is identity (the upstream IS the Anthropic Messages API); a REVERSE leg
  // (cc/responses/gemini client) translates source→Anthropic via the hub → env.body becomes Anthropic-shaped.
  //
  // NOTE (openai-responses reverse, C2-review): the master responses codec's translateOut ALSO eagerly
  // called `ensureReverseExchange(env)` here to pre-build the reverse responseId/itemId. This cell omits it
  // — the codec's RESPONSE-side `renderResponse`/`renderResponseNonStreaming` (still driven by the codec,
  // not this leg — S6 is InboundCodec's concern) builds it LAZILY (`??=`) on the first frame. Verified
  // OBSERVABLY EQUIVALENT: `reverseExchange` has NO request-side reader (only render consumes it; the handler
  // registers the session from the post-render `acc.responseId`, not the exchange), the ids are one-shot
  // `genShortId()` memoized either way, and clientModel primarily uses the parse-time `resolvedModelName`.
  // The `reverse-responses-messages` IT locks the reverse-exchange id preservation. Hoisting the exchange
  // state to a ctx side-channel (RFC §11.2) is a C4 (/responses leg) concern, not C2.
  translateOut(env) {
    if (!isReverse(env)) return env
    const anthropicBody = translateRequestVia(env.clientFormat, env.targetEndpoint, env.body, { model: env.model as Model | undefined })
    return env.with({ body: anthropicBody })
  },

  // S3: DIRECT = the Anthropic sanitize chain (quarantine + sanitize @ preprocessInfo). REVERSE = the reverse
  // Anthropic sanitize rewrite (strips orphan tool_result/system-reminders the source→Anthropic translation
  // left behind, using the shared per-request mapper holder — NOT the source ctx.toolNameMapper).
  requestRewrites(env): ReadonlyArray<RequestRewrite> {
    if (isReverse(env)) return [createReverseAnthropicSanitizeRewrite(reverseMapperHolder(env))]
    const preprocessInfo = env.requestState?.preprocessInfo ?? throwMissing("preprocessInfo")
    return [createQuarantineProactiveFilter(), createAnthropicSanitizeRewrite({ preprocessInfo, onInitialSanitizationInfo: () => {} })]
  },

  prepareWire(env): PreparedRequest {
    // REVERSE: no client anthropic-beta / headers / thinking+cache-control ctx side-channels (a non-Anthropic
    // client sends none) — the shared betaProbe records outbound betas for the reverse unsupported-beta probe.
    if (isReverse(env)) return prepareReverseAnthropicWire(env, env.requestState?.betaProbe)
    return prepareAnthropicWire(env, directWireDeps(env))
  },

  responseRewrites(): ReadonlyArray<ResponseRewrite> {
    // The driver's assembleResponseRewrites filters this full union to the /v1/messages subset via each
    // rewrite's targetEndpoint-keyed appliesTo — the same array the handlers passed as deps (direct + reverse).
    return ALL_RESPONSE_REWRITES
  },

  preSend(env): Promise<RequestEnvelope> {
    // REVERSE: no pre-flight truncation (the source codecs had no preSend; the reverse resanitize handles size).
    if (isReverse(env)) return Promise.resolve(env)
    return anthropicPreSend(env)
  },

  sampleWireTrack(wire, env): RequestSample {
    // The reverse sample is byte-identical to the direct one (both anthropic-messages-shaped effective+wire).
    const sample = sampleAnthropicRequest(wire, env)
    // Record this attempt's stripped cache_control subfields on the ctx attempt (the DIRECT wire carries them
    // from prepareAnthropicWire; the reverse wire carries none) — the retry pipeline-info rebuild reads it.
    const stripped = (wire as { strippedCacheControlSubfields?: ReadonlyArray<string> }).strippedCacheControlSubfields
    if (stripped?.length) env.ctx.setAttemptCacheControlStripped(stripped)
    return sample.requestSample
  },

  buildLegStrategies(spec: RetrySemanticsSpec, env): ReadonlyArray<RetryStrategy> {
    const rs = env.requestState
    // REVERSE: the truncation baseline is env.body (the translated Anthropic body — the source codecs used
    // `originalPayload: env.body`); resanitize is the reverse resanitize off the shared mapper holder.
    if (isReverse(env)) {
      return buildAnthropicStrategies({
        originalPayload: env.body as MessagesPayload,
        resanitize: buildReverseResanitize(reverseMapperHolder(env)),
        model: env.model as Model | undefined,
        maxRetries: spec.maxRetries,
        betaProbe: rs?.betaProbe ?? throwMissing("betaProbe"),
      })
    }
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

/**
 * RETRY_SEMANTICS for a REVERSE `@messages` cell (cc/responses/gemini client → Anthropic wire): the outbound
 * wire is Anthropic, so the ANTHROPIC strategy stack (auto-truncate + N retries) runs regardless of client
 * format — the R1/HIGH-A corner (`(openai-responses, /v1/messages)` has auto-truncate ON, unlike its direct
 * `/responses` leg which is OFF). The supply `maxRetries` is `autoTruncateMaxRetries` for all three (the
 * driver's top-level retry budget — 1 for responses — is a separate handler-level concern, not this spec).
 */
export function anthropicReverseRetrySemantics(label: string): RetrySemanticsSpec {
  return { autoTruncate: true, maxRetries: state.autoTruncateMaxRetries, label }
}

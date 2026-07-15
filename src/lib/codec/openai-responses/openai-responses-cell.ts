/**
 * The `/responses` (+ its `ws:` transport) OUTBOUND leg for the CellAssembly refactor (RFC 2026-07-13 §11).
 * Fills `OUTBOUND_LEGS[ENDPOINT.RESPONSES]` and `OUTBOUND_LEGS[ENDPOINT.WS_RESPONSES]` (the WS transport
 * shares the same wire — the router only ever routes to `/responses`; `ws:/responses` is a capability
 * marker, never a routed targetEndpoint, so the WS leg is a defensive alias of the RESPONSES leg).
 *
 * Cells sharing this leg (dispatched by clientFormat):
 *   - `openai-responses` (DIRECT `/responses`) — Responses-shaped env.body → `prepareResponsesDirectWire`.
 *     R1/HIGH-A corner: this cell's retry stack has auto-truncate OFF (maxRetries 1) — encoded in
 *     RETRY_SEMANTICS, dispatched in `buildCcFamilyLegStrategies`.
 *   - `openai-cc` / `gemini` (via-responses) — the hub translates source→CC in `translateOut`
 *     (identity for openai-cc, whose body is already CC), then the leg builds the CC→Responses wire in
 *     `prepareViaResponsesWire`. auto-truncate ON (the CC stack on the CC baseline).
 *   - `anthropic` (FORWARD `@responses`) — RFC 2026-07-14-anthropic-responses-direct-bridge §3 DIRECT
 *     bridge: the hub's `translateOut` produces a Responses-shaped body DIRECTLY (skips CC entirely —
 *     no multi-choices fold), so `prepareViaResponsesWire` only runs `prepareResponsesRequest` on it
 *     (no CC→Responses re-translation — R-NO-INTERNAL-ADAPT §2.3 three-point corner: this leg,
 *     `cc-family-strategies.ts`'s retry baseline, and `hub-translate.ts`'s bridge table entry were all
 *     updated together, else a Responses body would be mistaken for CC and double-translated).
 */

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

import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { translateRequestVia } from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"

import { buildCcFamilyLegStrategies } from "../cc-family-strategies"
import {
  //
  prepareResponsesDirectWire,
  prepareViaResponsesWire,
  sampleResponsesDirectWireTrack,
  sampleViaResponsesWireTrack,
} from "./openai-responses-leg"

/** Is this a DIRECT `(openai-responses, /responses)` cell (vs a via-responses/forward CC-shaped cell)? */
function isDirect(env: RequestEnvelope): boolean {
  return env.clientFormat === "openai-responses"
}

/** Build the `/responses` outbound leg — shared by the RESPONSES + WS_RESPONSES records (same wire). */
function makeResponsesLeg(targetEndpoint: typeof ENDPOINT.RESPONSES | typeof ENDPOINT.WS_RESPONSES): OutboundLeg {
  return {
    targetEndpoint,

    // S2: openai-responses DIRECT + openai-cc via-responses are identity (env.body is Responses/CC-shaped
    // already; the CC→Responses translation is deferred to prepareWire). anthropic/gemini FORWARD translate
    // source→CC via the hub → env.body becomes CC-shaped (the CC→Responses wire step is still in prepareWire).
    // Observability: cc/gemini via-responses record the `via-responses` bridge feature (parity with the
    // cc/gemini handlers' strategies factory); anthropic FORWARD `@responses` + openai-responses DIRECT
    // record none (the messages handler + direct path recorded no such feature). Once per request (S2).
    translateOut(env) {
      if (env.clientFormat === "openai-cc" || env.clientFormat === "gemini") env.ctx.recordFeature("via-responses")
      if (isDirect(env) || env.clientFormat === "openai-cc") return env
      const ccBody = translateRequestVia(env.clientFormat, ENDPOINT.RESPONSES, env.body, { model: env.model as Model | undefined, reqId: env.ctx.id })
      return env.with({ body: ccBody })
    },

    // S3: no request rewrite (the reverse-sanitize dep is MESSAGES-gated, inert on /responses).
    requestRewrites(): ReadonlyArray<RequestRewrite> {
      return []
    },

    prepareWire(env): PreparedRequest {
      // DIRECT: Responses-shaped env.body → Responses wire. via-responses/FORWARD: CC-shaped env.body →
      // CC→Responses wire (+ dropped-params warning + normalizeCallIds).
      return isDirect(env) ? prepareResponsesDirectWire(env) : prepareViaResponsesWire(env)
    },

    responseRewrites(): ReadonlyArray<ResponseRewrite> {
      return ALL_RESPONSE_REWRITES
    },

    // No preSend: neither the Responses nor the CC stack has an Anthropic-style pre-flight truncation.

    sampleWireTrack(wire, env): RequestSample {
      // DIRECT: Responses effective + Responses wire. via-responses: CC effective + Responses wire.
      return isDirect(env) ? sampleResponsesDirectWireTrack(wire, env) : sampleViaResponsesWireTrack(wire, env)
    },

    buildLegStrategies(spec: RetrySemanticsSpec, env): ReadonlyArray<RetryStrategy> {
      // R1/HIGH-A: spec.autoTruncate (false for the openai-responses DIRECT cell, true for the CC-family
      // via/forward cells) selects the Responses vs CC stack.
      return buildCcFamilyLegStrategies(spec, env)
    },
  }
}

/** `OUTBOUND_LEGS[RESPONSES]`. */
export const responsesLeg: OutboundLeg = makeResponsesLeg(ENDPOINT.RESPONSES)
/** `OUTBOUND_LEGS[WS_RESPONSES]` — the WS transport shares the RESPONSES wire (never a routed targetEndpoint). */
export const wsResponsesLeg: OutboundLeg = makeResponsesLeg(ENDPOINT.WS_RESPONSES)

/**
 * RETRY_SEMANTICS for the openai-responses DIRECT `/responses` cell — the R1/HIGH-A corner: auto-truncate
 * OFF, maxRetries 1 (the Responses stack, unlike its REVERSE `@messages` cell which is auto-truncate ON).
 */
export function responsesDirectRetrySemantics(): RetrySemanticsSpec {
  return { maxRetries: 1, label: "Responses" }
}

/** RETRY_SEMANTICS for a via-responses/FORWARD `@responses` cell (openai-cc/gemini/anthropic → Responses wire): the CC stack (auto-truncate ON). */
export function viaResponsesRetrySemantics(label: string): RetrySemanticsSpec {
  return { maxRetries: state.maxReactiveRetries, label }
}

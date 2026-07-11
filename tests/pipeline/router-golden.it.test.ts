/**
 * Phase 0 T0.0 — GOLDEN PRE-CAPTURE for the decideRoute → router extraction.
 *
 * This test freezes the CURRENT (pre-refactor) `RouteDecision` — INCLUDING the exact
 * `reason` strings — across the full matrix of (client format × model
 * `supported_endpoints` × vendor), captured on the unchanged HEAD before any source
 * moves. It is the byte-equivalence oracle for the whole Phase 0 refactor: Phase 0
 * relocates the 5 codecs' `decideRoute` into a single free-function `router.decideRoute`
 * WITHOUT any behavior change, so every commit (T0.1–T0.5) MUST keep this frozen table
 * passing byte-for-byte (large-refactor §4 golden pre-capture).
 *
 * Independent-oracle discipline (verifying-authoritative-claims): the EXPECTED decisions
 * below are hand-frozen literals captured from the pre-refactor code — NOT re-derived by
 * calling the code under test — so a refactor that silently changes a decision (or a reason
 * string) fails here instead of self-validating.
 *
 * ── The moving seam ──────────────────────────────────────────────────────────────────
 * The ONLY thing that changes across T0.0→T0.5 is the `routeDecisionUnderTest` helper —
 * it tracks the production routing call site as the logic migrates:
 *   - T0.0 (this commit): calls each codec's still-live `decideRoute(env)` (no router yet).
 *   - T0.1+:              calls the new free-function `router.decideRoute`, which dispatches
 *                         by clientFormat (anthropic native / others via the transition bridge
 *                         back to the codec, shrinking as T0.2–T0.4 migrate each format).
 *   - T0.5:               calls `router.decideRoute` with the bridge removed (codec methods gone).
 * The FROZEN TABLE never changes — it is the immutable oracle.
 *
 * Needs `state.modelIndex` (the anthropic decision resolves vendor by id through
 * `supportsDirectAnthropicApi`), hence `.it.test`.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type {
  //
  RouteDecision,
} from "~/lib/pipeline/types"

import { ENDPOINT } from "~/lib/models/endpoint"
import { decideRoute } from "~/lib/pipeline/router"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

// ── env stub (decideRoute reads only model + body.model + clientFormat) ──────────────
function envFor(model: Model | undefined, clientFormat: ClientFormat): RequestEnvelope {
  const id = model?.id ?? "unknown-unregistered-model"
  return {
    clientFormat,
    targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,
    model: model as unknown as RequestEnvelope["model"],
    stream: false,
    body: { model: id, messages: [] },
    view: {} as RequestEnvelope["view"],
    prepareHints: {},
    ctx: {} as RequestContext,
    with(patch) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as RequestEnvelope
}

// ═════════════════════════════════════════════════════════════════════════════════════
// THE MOVING SEAM — updated per T0.x to track the production routing call site.
// T0.5 (final): the free-function `router.decideRoute(env)`, dispatching by clientFormat. All
// 5 codec `decideRoute` implementations + the transition bridge are gone; routing is the
// router's sole responsibility, and this frozen table is its byte-equivalence oracle.
// ═════════════════════════════════════════════════════════════════════════════════════
function routeDecisionUnderTest(clientFormat: ClientFormat, model: Model | undefined): RouteDecision {
  return decideRoute(envFor(model, clientFormat))
}

// ── frozen matrix (the immutable oracle) ─────────────────────────────────────────────
interface MatrixRow {
  /** Stable id registered in state.modelIndex; also body.model when model is undefined. */
  id: string
  vendor: string
  endpoints: Array<string> | undefined
  /** `undefined` model passed to decideRoute (unknown gpt-* — index miss). */
  modelUndefined?: boolean
  anthropic: RouteDecision
  cc: RouteDecision
  responses: RouteDecision
  gemini: RouteDecision
}

const PT = (endpoint: UpstreamEndpoint): RouteDecision => ({ kind: "passthrough", endpoint })
const TR = (to: UpstreamEndpoint): RouteDecision => ({ kind: "translate", to })
const RJ = (reason: string): RouteDecision => ({ kind: "reject", status: 400, reason })

/**
 * Captured verbatim from the pre-refactor HEAD (Phase 0 T0.0). Rows span every
 * (vendor × supported_endpoints) combination the 5 decideRoute impls branch on,
 * plus the Google force-fallback (google-*) and the index-miss unknown model.
 */
const MATRIX: Array<MatrixRow> = [
  {
    id: "anthropic-msg",
    vendor: "Anthropic",
    endpoints: [ENDPOINT.MESSAGES],
    anthropic: PT(ENDPOINT.MESSAGES),
    cc: RJ('Model "anthropic-msg" does not support the /chat/completions endpoint'),
    responses: RJ('Model "anthropic-msg" does not support /responses or /chat/completions'),
    gemini: RJ('Model "anthropic-msg" does not support the /chat/completions endpoint'),
  },
  {
    id: "anthropic-no-msg",
    vendor: "Anthropic",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    anthropic: RJ('Model "anthropic-no-msg" does not support /v1/messages: model does not support /v1/messages endpoint'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    id: "cc-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    anthropic: RJ('Model "cc-only" does not support /v1/messages: vendor is "OpenAI", not Anthropic'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    id: "resp-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.RESPONSES],
    anthropic: RJ('Model "resp-only" does not support /v1/messages: vendor is "OpenAI", not Anthropic'),
    cc: TR(ENDPOINT.RESPONSES),
    responses: PT(ENDPOINT.RESPONSES),
    gemini: TR(ENDPOINT.RESPONSES),
  },
  {
    // ws:/responses counts as Responses support for the cc translate-decision.
    id: "ws-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.WS_RESPONSES],
    anthropic: RJ('Model "ws-only" does not support /v1/messages: vendor is "OpenAI", not Anthropic'),
    cc: TR(ENDPOINT.RESPONSES),
    responses: PT(ENDPOINT.RESPONSES),
    gemini: TR(ENDPOINT.RESPONSES),
  },
  {
    id: "cc-and-resp",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES],
    anthropic: RJ('Model "cc-and-resp" does not support /v1/messages: vendor is "OpenAI", not Anthropic'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    // Supports only /v1/messages but OpenAI vendor → all three reject it.
    id: "msg-only-openai",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.MESSAGES],
    anthropic: RJ('Model "msg-only-openai" does not support /v1/messages: vendor is "OpenAI", not Anthropic'),
    cc: RJ('Model "msg-only-openai" does not support the /chat/completions endpoint'),
    responses: RJ('Model "msg-only-openai" does not support /responses or /chat/completions'),
    gemini: RJ('Model "msg-only-openai" does not support the /chat/completions endpoint'),
  },
  {
    // Legacy model with no supported_endpoints → isEndpointSupported defaults true.
    id: "legacy-none",
    vendor: "OpenAI",
    endpoints: undefined,
    anthropic: RJ('Model "legacy-none" does not support /v1/messages: vendor is "OpenAI", not Anthropic'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    // Google force-fallback: Responses always translates to CC — even when the model
    // does NOT advertise /chat/completions (google-resp), exercising the force bypass.
    id: "google-resp",
    vendor: "Google",
    endpoints: [ENDPOINT.RESPONSES],
    anthropic: RJ('Model "google-resp" does not support /v1/messages: vendor is "Google", not Anthropic'),
    cc: TR(ENDPOINT.RESPONSES),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
    gemini: TR(ENDPOINT.RESPONSES),
  },
  {
    id: "google-none",
    vendor: "Google",
    endpoints: undefined,
    anthropic: RJ('Model "google-none" does not support /v1/messages: vendor is "Google", not Anthropic'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    // Google + CC advertised → force-fallback still routes Responses → CC (translate).
    id: "google-cc",
    vendor: "Google",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    anthropic: RJ('Model "google-cc" does not support /v1/messages: vendor is "Google", not Anthropic'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    // Google + only /v1/messages: force-fallback wants CC but CC support is exempt from
    // the check → responses translates to CC anyway; cc/gemini (no force) reject.
    id: "google-msg",
    vendor: "Google",
    endpoints: [ENDPOINT.MESSAGES],
    anthropic: RJ('Model "google-msg" does not support /v1/messages: vendor is "Google", not Anthropic'),
    cc: RJ('Model "google-msg" does not support the /chat/completions endpoint'),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
    gemini: RJ('Model "google-msg" does not support the /chat/completions endpoint'),
  },
  {
    // Unknown model (index miss → model undefined): legacy-true defaults apply. The
    // anthropic id falls back to body.model ("unknown-unregistered-model") + vendor "unknown".
    id: "unknown-gpt",
    vendor: "OpenAI",
    endpoints: undefined,
    modelUndefined: true,
    anthropic: RJ('Model "unknown-unregistered-model" does not support /v1/messages: vendor is "unknown", not Anthropic'),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
    gemini: PT(ENDPOINT.CHAT_COMPLETIONS),
  },
]

describe("Phase 0 T0.0 — golden decideRoute matrix (frozen pre-refactor oracle)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setModels({
      object: "list",
      data: MATRIX.filter((r) => !r.modelUndefined).map((row) =>
        mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) }),
      ),
    })
  })

  for (const row of MATRIX) {
    const label = `${row.id} (vendor=${row.vendor}, endpoints=${row.endpoints ? row.endpoints.join("+") : "none"}${row.modelUndefined ? ", model=undefined" : ""})`

    const modelOf = (): Model | undefined =>
      row.modelUndefined ? undefined : mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })

    test(`anthropic: ${label}`, () => {
      expect(routeDecisionUnderTest("anthropic", modelOf())).toEqual(row.anthropic)
    })
    test(`openai-cc: ${label}`, () => {
      expect(routeDecisionUnderTest("openai-cc", modelOf())).toEqual(row.cc)
    })
    test(`openai-responses: ${label}`, () => {
      expect(routeDecisionUnderTest("openai-responses", modelOf())).toEqual(row.responses)
    })
    test(`gemini: ${label}`, () => {
      expect(routeDecisionUnderTest("gemini", modelOf())).toEqual(row.gemini)
    })
  }
})

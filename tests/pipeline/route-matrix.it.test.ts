/**
 * P3.1 — unified pass-through route matrix.
 *
 * `decideRoute` was folded into each codec during P2, replacing the legacy 4
 * scattered decision sites (messages:165 / cc:305 / responses:138 / responses-ws)
 * + Gemini's no-gate. This table-driven test asserts the *collective*
 * RouteDecision across (client format × model `supported_endpoints`), pinning the
 * deliberately non-uniform defaults (docs/v4/03-spec/codec.md §2) so a future
 * "tidy-up" cannot silently flatten them:
 *   - `isEndpointSupported` absent → true  → legacy/unknown models passthrough.
 *   - Gemini has no endpoint gate          → its decision delegates to the cc codec.
 *   - the Responses Google force-list      → translate /chat/completions even when
 *                                             the model does NOT advertise CC.
 * (`isWsResponsesSupported` absent → false is a transport concern — HTTP-vs-WS
 * second choice in upstream-ws-attempt.ts — NOT a decideRoute branch, so it is
 * out of this matrix.)
 *
 * Needs `state.modelIndex` (the anthropic codec resolves vendor by id through
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
  FormatCodec,
  RouteDecision,
} from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { createOpenAiGeminiCodec } from "~/lib/codec/openai-gemini/codec"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { ENDPOINT } from "~/lib/models/endpoint"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { autoTestRuntime } from "../helpers/test-bootstrap"

// ── env stub (decideRoute reads only model + body.model + clientFormat) ───────

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

// ── codec factories (decideRoute is pure; fresh per call for isolation) ───────

function anthropicCodec(): FormatCodec {
  return createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
}

// ── normalized decision (drop the reason string; it varies per model) ─────────

type NormDecision = { kind: "passthrough"; endpoint: UpstreamEndpoint } | { kind: "translate"; to: UpstreamEndpoint } | { kind: "reject"; status: number }

function norm(d: RouteDecision): NormDecision {
  if (d.kind === "passthrough") return { kind: "passthrough", endpoint: d.endpoint }
  if (d.kind === "translate") return { kind: "translate", to: d.to }
  return { kind: "reject", status: d.status }
}

const PT = (endpoint: UpstreamEndpoint): NormDecision => ({ kind: "passthrough", endpoint })
const TR = (to: UpstreamEndpoint): NormDecision => ({ kind: "translate", to })
const RJ: NormDecision = { kind: "reject", status: 400 }

// ── the matrix ────────────────────────────────────────────────────────────────

interface MatrixRow {
  /** Stable id registered in state.modelIndex; `undefined` = model not registered. */
  id: string
  vendor: string
  endpoints: Array<string> | undefined
  /** `undefined` model passed to decideRoute (unknown gpt-* — index miss). */
  modelUndefined?: boolean
  anthropic: NormDecision
  cc: NormDecision
  responses: NormDecision
}

const MATRIX: Array<MatrixRow> = [
  // Anthropic-vendor models.
  { id: "anthropic-msg", vendor: "Anthropic", endpoints: [ENDPOINT.MESSAGES], anthropic: PT(ENDPOINT.MESSAGES), cc: RJ, responses: RJ },
  // Anthropic vendor but NO /v1/messages → anthropic rejects; cc/responses see a
  // plain CC-capable model.
  {
    id: "anthropic-no-msg",
    vendor: "Anthropic",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    anthropic: RJ,
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
  },

  // OpenAI-vendor models across the endpoint spectrum.
  {
    id: "cc-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    anthropic: RJ,
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
  },
  { id: "resp-only", vendor: "OpenAI", endpoints: [ENDPOINT.RESPONSES], anthropic: RJ, cc: TR(ENDPOINT.RESPONSES), responses: PT(ENDPOINT.RESPONSES) },
  // ws:/responses counts as Responses support for the cc translate-decision.
  { id: "ws-only", vendor: "OpenAI", endpoints: [ENDPOINT.WS_RESPONSES], anthropic: RJ, cc: TR(ENDPOINT.RESPONSES), responses: PT(ENDPOINT.RESPONSES) },
  {
    id: "cc-and-resp",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES],
    anthropic: RJ,
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
  },
  // Supports only /v1/messages but OpenAI vendor → all three reject it.
  { id: "msg-only-openai", vendor: "OpenAI", endpoints: [ENDPOINT.MESSAGES], anthropic: RJ, cc: RJ, responses: RJ },

  // Legacy model with no supported_endpoints → isEndpointSupported defaults true.
  { id: "legacy-none", vendor: "OpenAI", endpoints: undefined, anthropic: RJ, cc: PT(ENDPOINT.CHAT_COMPLETIONS), responses: PT(ENDPOINT.RESPONSES) },

  // Google force-list: Responses always translates to CC — even when the model
  // does NOT advertise /chat/completions (google-resp), exercising the bypass.
  { id: "google-resp", vendor: "Google", endpoints: [ENDPOINT.RESPONSES], anthropic: RJ, cc: TR(ENDPOINT.RESPONSES), responses: TR(ENDPOINT.CHAT_COMPLETIONS) },
  { id: "google-none", vendor: "Google", endpoints: undefined, anthropic: RJ, cc: PT(ENDPOINT.CHAT_COMPLETIONS), responses: TR(ENDPOINT.CHAT_COMPLETIONS) },

  // Unknown model (index miss → model undefined): legacy-true defaults apply.
  {
    id: "unknown-gpt",
    vendor: "OpenAI",
    endpoints: undefined,
    modelUndefined: true,
    anthropic: RJ,
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
  },
]

describe("P3.1 — unified decideRoute matrix (client format × supported_endpoints)", () => {
  autoTestRuntime()

  beforeEach(() => {
    setModels({
      object: "list",
      data: MATRIX.map((row) => mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })),
    })
  })

  for (const row of MATRIX) {
    const label = `${row.id} (vendor=${row.vendor}, endpoints=${row.endpoints ? row.endpoints.join("+") : "none"}${row.modelUndefined ? ", model=undefined" : ""})`

    test(`anthropic: ${label}`, () => {
      const model =
        row.modelUndefined ? undefined : mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })
      expect(norm(anthropicCodec().decideRoute(envFor(model, "anthropic")))).toEqual(row.anthropic)
    })

    test(`openai-cc: ${label}`, () => {
      const model =
        row.modelUndefined ? undefined : mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })
      expect(norm(createOpenAiCcCodec().decideRoute(envFor(model, "openai-cc")))).toEqual(row.cc)
    })

    test(`openai-responses: ${label}`, () => {
      const model =
        row.modelUndefined ? undefined : mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })
      expect(norm(createOpenAiResponsesCodec().decideRoute(envFor(model, "openai-responses")))).toEqual(row.responses)
    })

    // Gemini has no endpoint gate of its own — its decideRoute delegates to the
    // internal cc codec, so it must equal the cc decision for the same model.
    test(`gemini delegates to cc: ${label}`, () => {
      const model =
        row.modelUndefined ? undefined : mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })
      const env = envFor(model, "gemini")
      expect(norm(createOpenAiGeminiCodec(row.id).decideRoute(env))).toEqual(norm(createOpenAiCcCodec().decideRoute(env)))
      // …and that shared decision is the cc expectation.
      expect(norm(createOpenAiGeminiCodec(row.id).decideRoute(env))).toEqual(row.cc)
    })
  }
})

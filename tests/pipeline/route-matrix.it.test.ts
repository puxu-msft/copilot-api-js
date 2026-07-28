/**
 * Unified route-decision matrix (client format × model `supported_endpoints`).
 *
 * `decideRoute` was extracted from the per-codec methods into the free-function
 * `router.decideRoute` (ADR 2026-07-11-route-decision-separated-from-format-codec), the single
 * reader of upstream model capabilities. This table-driven test asserts the *collective*
 * RouteDecision the router produces, pinning the deliberately non-uniform defaults
 * (docs/v4/03-spec/codec.md §2) so a future "tidy-up" cannot silently flatten them:
 *   - `isEndpointSupported` absent → true  → legacy/unknown models passthrough.
 *   - Gemini has no endpoint gate          → its decision mirrors the openai-cc decision.
 *   - the Responses Google force-list      → translate /chat/completions even when
 *                                             the model does NOT advertise CC.
 * (`isWsResponsesSupported` absent → false is a transport concern — HTTP-vs-WS
 * second choice in upstream-ws-attempt.ts — NOT a decideRoute branch, so it is
 * out of this matrix.)
 *
 * Complements `router-golden.it.test.ts` (the Phase 0 frozen oracle that also freezes the exact
 * reject `reason` strings); this one keeps the `norm()`-based collective assertion + the explicit
 * gemini==cc delegation framing. Needs `state.modelIndex` (the anthropic decision resolves vendor
 * by id through `supportsDirectAnthropicApi`), hence `.it.test`.
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

import { setModels } from "~/lib/models/cache"
import { ENDPOINT } from "~/lib/models/endpoint"
import { decideRoute } from "~/lib/pipeline/router"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

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
    anthropic: TR(ENDPOINT.CHAT_COMPLETIONS),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
  },

  // OpenAI-vendor models across the endpoint spectrum.
  {
    id: "cc-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    anthropic: TR(ENDPOINT.CHAT_COMPLETIONS),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    id: "resp-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.RESPONSES],
    anthropic: TR(ENDPOINT.RESPONSES),
    cc: TR(ENDPOINT.RESPONSES),
    responses: PT(ENDPOINT.RESPONSES),
  },
  // ws:/responses counts as Responses support for the cc translate-decision.
  {
    id: "ws-only",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.WS_RESPONSES],
    anthropic: TR(ENDPOINT.RESPONSES),
    cc: TR(ENDPOINT.RESPONSES),
    responses: PT(ENDPOINT.RESPONSES),
  },
  {
    id: "cc-and-resp",
    vendor: "OpenAI",
    endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES],
    anthropic: TR(ENDPOINT.RESPONSES),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
  },
  // Supports only /v1/messages but OpenAI vendor → all three reject it.
  { id: "msg-only-openai", vendor: "OpenAI", endpoints: [ENDPOINT.MESSAGES], anthropic: RJ, cc: RJ, responses: RJ },

  // Legacy model with no supported_endpoints → isEndpointSupported (and thus isResponsesSupported) defaults true.
  {
    id: "legacy-none",
    vendor: "OpenAI",
    endpoints: undefined,
    anthropic: TR(ENDPOINT.RESPONSES),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
  },

  // Google force-list: Responses always translates to CC — even when the model
  // does NOT advertise /chat/completions (google-resp), exercising the bypass. Anthropic no-suffix
  // routes these through /responses too → force-fallback → CC (Phase 7).
  {
    id: "google-resp",
    vendor: "Google",
    endpoints: [ENDPOINT.RESPONSES],
    anthropic: TR(ENDPOINT.CHAT_COMPLETIONS),
    cc: TR(ENDPOINT.RESPONSES),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
  },
  {
    id: "google-none",
    vendor: "Google",
    endpoints: undefined,
    anthropic: TR(ENDPOINT.CHAT_COMPLETIONS),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: TR(ENDPOINT.CHAT_COMPLETIONS),
  },

  // Unknown model (index miss → model undefined): legacy-true defaults apply.
  {
    id: "unknown-gpt",
    vendor: "OpenAI",
    endpoints: undefined,
    modelUndefined: true,
    anthropic: TR(ENDPOINT.RESPONSES),
    cc: PT(ENDPOINT.CHAT_COMPLETIONS),
    responses: PT(ENDPOINT.RESPONSES),
  },
]

describe("unified decideRoute matrix (client format × supported_endpoints)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setModels({
      object: "list",
      data: MATRIX.map((row) => mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })),
    })
  })

  for (const row of MATRIX) {
    const label = `${row.id} (vendor=${row.vendor}, endpoints=${row.endpoints ? row.endpoints.join("+") : "none"}${row.modelUndefined ? ", model=undefined" : ""})`

    const modelOf = (): Model | undefined =>
      row.modelUndefined ? undefined : mockModel(row.id, { vendor: row.vendor, ...(row.endpoints !== undefined && { supported_endpoints: row.endpoints }) })

    test(`anthropic: ${label}`, () => {
      expect(norm(decideRoute(envFor(modelOf(), "anthropic")))).toEqual(row.anthropic)
    })

    test(`openai-cc: ${label}`, () => {
      expect(norm(decideRoute(envFor(modelOf(), "openai-cc")))).toEqual(row.cc)
    })

    test(`openai-responses: ${label}`, () => {
      expect(norm(decideRoute(envFor(modelOf(), "openai-responses")))).toEqual(row.responses)
    })

    // Gemini has no endpoint gate of its own — the router mirrors the openai-cc decision for
    // the same model, so it must equal the cc decision.
    test(`gemini mirrors cc: ${label}`, () => {
      const model = modelOf()
      expect(norm(decideRoute(envFor(model, "gemini")))).toEqual(norm(decideRoute(envFor(model, "openai-cc"))))
      // …and that shared decision is the cc expectation.
      expect(norm(decideRoute(envFor(model, "gemini")))).toEqual(row.cc)
    })
  }
})

/**
 * Phase 1 (translation-matrix) — explicit-leg routing (`@cc` / `@responses` / `@messages`).
 *
 * Covers the ADDITIVE full-matrix decision paths the `env.routeOverride` suffix unlocks
 * (RFC 2026-07-11-anthropic-via-openai-translation §4.3), on top of the no-suffix behavior
 * frozen by `router-golden.it.test.ts` / asserted by `route-matrix.it.test.ts`. The golden
 * exercises NO suffix, so everything here is new surface — it must NOT perturb the golden.
 *
 * The three behaviors under test:
 *   - candidate leg = OVERRIDE_LEG[suffix], kind = passthrough (== inbound default) vs translate.
 *   - unified force-fallback: a force-vendor (Google) `/responses` leg → CC, EVEN over @responses
 *     (FAIL-Google-2 "force-vendor 优先于显式后缀").
 *   - strict gate (FAIL-3): a pin to a leg the model can't serve → reject 400 (no silent reroute);
 *     W4 legacy-true lets a no-`supported_endpoints` model pass the CC/messages gate.
 *
 * Needs `state.modelIndex` (the @messages gate resolves vendor via `supportsDirectAnthropicApi`),
 * hence `.it.test`.
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
import type { RouteOverride } from "~/lib/models/normalize-id"
import type {
  //
  ClientFormat,
  RequestEnvelope,
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

function envFor(model: Model | undefined, clientFormat: ClientFormat, routeOverride?: RouteOverride): RequestEnvelope {
  const id = model?.id ?? "unknown-unregistered-model"
  return {
    clientFormat,
    targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,
    ...(routeOverride && { routeOverride }),
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

describe("Phase 1 — explicit-leg routing (@cc / @responses / @messages)", () => {
  useIsolatedRuntime()

  const anthropicMsg = () => mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] })
  const openaiCcAndResp = () => mockModel("gpt-x", { vendor: "OpenAI", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })
  const openaiCcOnly = () => mockModel("gpt-cc", { vendor: "OpenAI", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS] })
  const openaiRespOnly = () => mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: [ENDPOINT.RESPONSES] })
  const googleResp = () => mockModel("gemini-resp", { vendor: "Google", supported_endpoints: [ENDPOINT.RESPONSES] })
  const legacyNone = () => mockModel("legacy", { vendor: "OpenAI" }) // no supported_endpoints

  beforeEach(() => {
    setModels({
      object: "list",
      data: [anthropicMsg(), openaiCcAndResp(), openaiCcOnly(), openaiRespOnly(), googleResp(), legacyNone()],
    })
  })

  // ── passthrough vs translate: leg == inbound default → passthrough, else translate ──

  test("@cc from openai-cc (== default leg) → passthrough /chat/completions", () => {
    expect(decideRoute(envFor(openaiCcAndResp(), "openai-cc", "cc"))).toEqual<RouteDecision>({ kind: "passthrough", endpoint: ENDPOINT.CHAT_COMPLETIONS })
  })

  test("@responses from openai-cc (!= default leg) → translate /responses", () => {
    expect(decideRoute(envFor(openaiCcAndResp(), "openai-cc", "responses"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.RESPONSES })
  })

  test("@responses from openai-responses (== default leg) → passthrough /responses", () => {
    expect(decideRoute(envFor(openaiCcAndResp(), "openai-responses", "responses"))).toEqual<RouteDecision>({ kind: "passthrough", endpoint: ENDPOINT.RESPONSES })
  })

  test("@cc from openai-responses (!= default leg) → translate /chat/completions", () => {
    expect(decideRoute(envFor(openaiCcAndResp(), "openai-responses", "cc"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.CHAT_COMPLETIONS })
  })

  test("@cc from gemini (== default leg) → passthrough /chat/completions", () => {
    expect(decideRoute(envFor(openaiCcAndResp(), "gemini", "cc"))).toEqual<RouteDecision>({ kind: "passthrough", endpoint: ENDPOINT.CHAT_COMPLETIONS })
  })

  test("@responses from gemini (!= default leg) → translate /responses", () => {
    expect(decideRoute(envFor(openaiCcAndResp(), "gemini", "responses"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.RESPONSES })
  })

  test("@messages from anthropic (== default leg) → passthrough /v1/messages", () => {
    expect(decideRoute(envFor(anthropicMsg(), "anthropic", "messages"))).toEqual<RouteDecision>({ kind: "passthrough", endpoint: ENDPOINT.MESSAGES })
  })

  // @cc/@responses from anthropic are the FORWARD translation legs — wired in Phase 2+.
  // In Phase 1 the leg resolves + gates (strict), but an OpenAI-capable model is required.
  test("@cc from anthropic to a CC-capable model → translate /chat/completions", () => {
    expect(decideRoute(envFor(openaiCcOnly(), "anthropic", "cc"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.CHAT_COMPLETIONS })
  })

  // ── unified force-fallback: Google /responses → CC, even over @responses ──

  test("@responses on a Google force-vendor model → translate /chat/completions (force wins over suffix)", () => {
    // openai-responses inbound: default leg /responses; force retargets to CC → translate.
    expect(decideRoute(envFor(googleResp(), "openai-responses", "responses"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.CHAT_COMPLETIONS })
  })

  test("@responses from openai-cc on a Google model → passthrough /chat/completions (force retarget == cc default leg)", () => {
    // Force retargets /responses → CC; for openai-cc inbound CC IS the default leg → passthrough
    // (the body is already CC-shaped, no translation needed).
    expect(decideRoute(envFor(googleResp(), "openai-cc", "responses"))).toEqual<RouteDecision>({ kind: "passthrough", endpoint: ENDPOINT.CHAT_COMPLETIONS })
  })

  // ── strict gate (FAIL-3): pin to an unsupported leg → reject 400 ──

  test("@responses to a model without /responses support → reject 400", () => {
    const d = decideRoute(envFor(openaiCcOnly(), "openai-cc", "responses"))
    expect(d.kind).toBe("reject")
    if (d.kind === "reject") {
      expect(d.status).toBe(400)
      expect(d.reason).toContain("@responses")
    }
  })

  test("@cc to a model without /chat/completions support → reject 400", () => {
    const d = decideRoute(envFor(openaiRespOnly(), "openai-responses", "cc"))
    expect(d.kind).toBe("reject")
    if (d.kind === "reject") expect(d.reason).toContain("@cc")
  })

  test("@messages to a non-Anthropic model → reject 400 (real direct-Anthropic gate, not bare endpoint list)", () => {
    // An OpenAI model that happens to list /v1/messages still cannot serve an Anthropic-wire request.
    const openaiWithMsg = mockModel("gpt-msg", { vendor: "OpenAI", supported_endpoints: [ENDPOINT.MESSAGES] })
    setModels({ object: "list", data: [openaiWithMsg] })
    const d = decideRoute(envFor(openaiWithMsg, "openai-cc", "messages"))
    expect(d.kind).toBe("reject")
    if (d.kind === "reject") expect(d.reason).toContain("/v1/messages")
  })

  // ── W4 legacy-true: a no-supported_endpoints model passes the CC gate ──

  test("@cc to a legacy model with no supported_endpoints → passes the CC gate (legacy-true)", () => {
    // openai-responses inbound + @cc: not the default leg → translate; the legacy-true
    // gate lets it through (isEndpointSupported absent → true).
    expect(decideRoute(envFor(legacyNone(), "openai-responses", "cc"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.CHAT_COMPLETIONS })
  })

  // ── index-miss (model undefined): legacy-true gate lets both CC and Responses through ──

  test("@cc / @responses with an unregistered model (index miss) → legacy-true gate passes both", () => {
    // isEndpointSupported(undefined) → true, isResponsesSupported(undefined) → true (legacy
    // universal-fallback default): an unknown model is routed and left for the upstream to reject.
    expect(decideRoute(envFor(undefined, "openai-cc", "cc"))).toEqual<RouteDecision>({ kind: "passthrough", endpoint: ENDPOINT.CHAT_COMPLETIONS })
    expect(decideRoute(envFor(undefined, "openai-cc", "responses"))).toEqual<RouteDecision>({ kind: "translate", to: ENDPOINT.RESPONSES })
    // @messages still needs the real Anthropic-vendor gate → an unknown-vendor model rejects.
    expect(decideRoute(envFor(undefined, "openai-cc", "messages")).kind).toBe("reject")
  })
})

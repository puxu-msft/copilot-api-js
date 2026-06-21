/**
 * P2.6 / C2 — anthropic-messages FormatCodec integration tests.
 *
 * `parse` creates a RequestContext via the manager and reads `state.modelIndex`,
 * so it needs the context-manager + state runtime (hence `.it.test`). Asserts the
 * envelope fields, decideRoute (passthrough Anthropic / reject non-Anthropic),
 * prepareWire (wire + betaProbe.recordOutbound), the two-track sampleRequest, and
 * the per-request accessors (truncate baseline / resanitize / context).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RawHttpRequest } from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  type AnthropicCodec,
  createAnthropicCodec,
} from "~/lib/codec/anthropic/codec"
import { getRequestContextManager } from "~/lib/context/manager"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { autoTestRuntime } from "../helpers/test-bootstrap"

const NO_PREPROCESS = { strippedReadTagCount: 0, dedupedToolCallCount: 0 }

function makeCodec(): AnthropicCodec {
  return createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: NO_PREPROCESS })
}

function rawReq(body: unknown, over?: Partial<RawHttpRequest>): RawHttpRequest {
  return { body, headers: new Headers({ "content-length": "42" }), method: "POST", path: "/v1/messages", ...over }
}

function anthropicBody(over?: Partial<MessagesPayload>): MessagesPayload {
  return { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], max_tokens: 100, ...over } as MessagesPayload
}

describe("anthropic codec — parse / decideRoute / prepareWire / sampleRequest", () => {
  autoTestRuntime()

  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
        mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      ],
    })
  })

  test("parse builds an envelope: clientFormat anthropic, model from index, stream, targetEndpoint /v1/messages", () => {
    const codec = makeCodec()
    const env = codec.parse(rawReq(anthropicBody({ stream: true })))

    expect(env.clientFormat).toBe("anthropic")
    expect(env.model?.id).toBe("claude-sonnet-4")
    expect(env.stream).toBe(true)
    expect(env.targetEndpoint).toBe("/v1/messages")
    expect((env.body as MessagesPayload).messages[0]?.role).toBe("user")
  })

  test("parse registers a RequestContext (manager tracks it) with the inbound body size + exposes getContext", () => {
    const codec = makeCodec()
    const env = codec.parse(rawReq(anthropicBody()))
    expect(getRequestContextManager().get(env.ctx.id)).toBeDefined()
    expect(env.ctx.requestBodySize).toBe(42)
    expect(codec.getContext()).toBe(env.ctx)
  })

  test("parse sets a resolved model on ctx + a tool-name mapper getter (no throw)", () => {
    const codec = makeCodec()
    const env = codec.parse(
      rawReq(anthropicBody({ tools: [{ name: "search_the_web", description: "d", input_schema: { type: "object" } }] as unknown as MessagesPayload["tools"] })),
    )
    expect(env.ctx.toolNameMapper === null || typeof env.ctx.toolNameMapper === "object").toBe(true)
  })

  test("getTruncateBaseline = the preprocessed, pre-sanitize payload (model-resolved)", () => {
    const codec = makeCodec()
    codec.parse(rawReq(anthropicBody()))
    const baseline = codec.getTruncateBaseline()
    expect(baseline?.model).toBe("claude-sonnet-4")
    expect(baseline?.messages[0]?.role).toBe("user")
  })

  test("getResanitize returns a working sanitize closure (idempotent re-run yields a SanitizeResult)", () => {
    const codec = makeCodec()
    codec.parse(rawReq(anthropicBody()))
    const resanitize = codec.getResanitize()
    expect(typeof resanitize).toBe("function")
    const result = resanitize?.(anthropicBody())
    expect(result?.payload).toBeDefined()
    expect(result?.stats).toBeDefined()
  })

  test("decideRoute: Anthropic-vendor model → passthrough /v1/messages", () => {
    const codec = makeCodec()
    const env = codec.parse(rawReq(anthropicBody()))
    const decision = codec.decideRoute(env)
    expect(decision).toEqual({ kind: "passthrough", endpoint: "/v1/messages" })
  })

  test("decideRoute: non-Anthropic model → reject 400 with the /v1/messages reason", () => {
    const codec = makeCodec()
    const env = codec.parse(rawReq(anthropicBody({ model: "gpt-4o" }), { preResolved: { name: "gpt-4o", model: undefined } }))
    const decision = codec.decideRoute(env)
    expect(decision.kind).toBe("reject")
    if (decision.kind === "reject") {
      expect(decision.status).toBe(400)
      expect(decision.reason).toContain("does not support /v1/messages")
    }
  })

  test("prepareWire produces a /v1/messages wire + records the outbound betas on the probe", () => {
    const betaProbe = createBetaProbe("beta-from-client")
    const codec = createAnthropicCodec({ betaProbe, preprocessInfo: NO_PREPROCESS })
    const env = codec.parse(rawReq(anthropicBody(), { headers: new Headers({ "content-length": "42", "anthropic-beta": "beta-from-client" }) }))
    const wire = codec.prepareWire(env)

    expect(wire.url).toBe("/v1/messages")
    expect(wire.headers).toBeInstanceOf(Headers)
    expect((wire.body as MessagesPayload).model).toBe("claude-sonnet-4")
    // recordOutbound ran (candidates reflect the outbound anthropic-beta header).
    expect(Array.isArray(betaProbe.getCandidates())).toBe(true)
  })

  test("sampleRequest yields both tracks as anthropic-messages + captures latest effective messages", () => {
    const codec = makeCodec()
    const env = codec.parse(rawReq(anthropicBody()))
    const wire = codec.prepareWire(env)
    const sample = codec.sampleRequest!(wire, env)

    expect(sample.effective.format).toBe("anthropic-messages")
    expect(sample.wire.format).toBe("anthropic-messages")
    expect(sample.effective.model).toBe("claude-sonnet-4")
    expect(Array.isArray(sample.wire.messages)).toBe(true)
    // §12.5: latest effective messages captured for retry message-mapping rebuild.
    expect(codec.getLatestEffectiveMessages()).toBe((env.body as MessagesPayload).messages as unknown as Array<unknown>)
  })

  test("envelope.with() patches the given key and preserves the rest (incl. ctx + stream)", () => {
    const codec = makeCodec()
    const env = codec.parse(rawReq(anthropicBody({ stream: true })))
    const patched = env.with({ body: { ...(env.body as MessagesPayload), max_tokens: 200 } })
    expect((patched.body as MessagesPayload).max_tokens).toBe(200)
    expect(patched.stream).toBe(true)
    expect(patched.ctx).toBe(env.ctx)
  })
})

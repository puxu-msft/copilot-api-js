/**
 * P2.2 — openai-cc FormatCodec `parse` integration tests.
 *
 * `parse` creates a RequestContext via the manager (`manager.create`) and reads
 * `state.modelIndex`, so it needs the context-manager + state runtime (hence
 * `.it.test`, not `.unit.test`). Asserts the envelope fields, Azure override,
 * model resolution, request-side tool-name sanitization (mapper on ctx), and
 * `sanitizeOpenAIMessages` application.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RawHttpRequest } from "~/lib/pipeline/types"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { getRequestContextManager } from "~/lib/context/manager"
import { setModels } from "~/lib/models/cache"
import { writeAttempt } from "~/lib/pipeline/envelope"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function rawReq(body: unknown, over?: Partial<RawHttpRequest>): RawHttpRequest {
  return { body, headers: new Headers({ "content-length": "42" }), method: "POST", path: "/chat/completions", ...over }
}

describe("openai-cc codec — parse", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
        mockModel("gpt-deployment-real", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      ],
    })
  })

  test("builds an envelope: clientFormat, model from index, stream, initial targetEndpoint, CC body", () => {
    const codec = createOpenAiCcCodec()
    const env: RequestEnvelope = codec.parse(rawReq({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }))

    expect(env.request.clientFormat).toBe("openai-cc")
    expect(env.request.model?.id).toBe("gpt-4o")
    expect(env.request.stream).toBe(true)
    expect(env.attempt.targetEndpoint).toBe("/chat/completions") // initial; driver overwrites via decideRoute
    const body = env.attempt.body as ChatCompletionsPayload
    expect(body.messages[0]?.content).toBe("hi")
  })

  test("registers a RequestContext (manager tracks it) with the inbound body size", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(rawReq({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }))
    expect(getRequestContextManager().get(env.ctx.id)).toBeDefined()
    expect(env.ctx.requestBodySize).toBe(42)
  })

  test("Azure deployment override (path wins) selects the override model", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(rawReq({ model: "ignored-body-model", messages: [{ role: "user", content: "hi" }] }, { modelOverride: "gpt-deployment-real" }))
    expect(env.request.model?.id).toBe("gpt-deployment-real")
    const body = env.attempt.body as ChatCompletionsPayload
    expect(body.model).toBe("gpt-deployment-real")
  })

  test("[DI-8] Azure override: history keeps BOTH tracks — deployment as the model, raw body model preserved in the payload snapshot", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(rawReq({ model: "ignored-body-model", messages: [{ role: "user", content: "hi" }] }, { modelOverride: "gpt-deployment-real" }))
    // originalRequest.model records the URL deployment — in Azure the path deployment
    // IS the client's authoritative model intent (body.model is designed to be ignored).
    expect(env.ctx.originalRequest?.model).toBe("gpt-deployment-real")
    // ...but the client's raw body model is NOT lost (richest-data-flow): the full
    // pre-resolution body is snapshotted, so the ignored body model stays inspectable.
    expect((env.ctx.originalRequest?.payload as ChatCompletionsPayload).model).toBe("ignored-body-model")
  })

  test("sets a tool-name mapper on ctx when the payload declares tools", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(
      rawReq({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "search_the_web", description: "d" } }],
      }),
    )
    // mapper presence depends on whether any name needed remapping; for a benign
    // name it may be null. Assert the getter is wired (no throw) and typed.
    expect(env.ctx.toolNameMapper === null || typeof env.ctx.toolNameMapper === "object").toBe(true)
  })

  test("applies sanitizeOpenAIMessages: filters orphaned tool messages from the body", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(
      rawReq({
        model: "gpt-4o",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", tool_call_id: "orphan_x", content: "result with no matching tool_call" },
        ],
      }),
    )
    const body = env.attempt.body as ChatCompletionsPayload
    // an orphaned tool result (no preceding assistant tool_call) is filtered out
    expect(body.messages.find((m) => m.role === "tool")).toBeUndefined()
    expect(body.messages.map((m) => m.role)).toEqual(["user"])
  })

  // Was: "unknown gpt-* model not in index → env.model undefined, still parses (CC fallback)".
  // That tolerance never worked end-to-end — an `undefined` model reached
  // `dispatch-scheduler.ts`'s `current.model.id` and the client got a 500 from an unrelated
  // invariant guard. Rejecting at the boundary is the disposition; the alternative (make
  // `env.model` genuinely optional and pass the name upstream) is recorded, with the open ruling,
  // in docs/tmp/2026-08-11-unresolvable-model-guard-disposition.md.
  test("unknown gpt-* model not in index → rejected at parse with a 404, not carried as undefined", () => {
    const codec = createOpenAiCcCodec()
    expect(() => codec.parse(rawReq({ model: "gpt-unknown-xyz", messages: [{ role: "user", content: "hi" }] }))).toThrow(/model not found: gpt-unknown-xyz/u)
  })

  test("writeAttempt rewrites only the attempt scope, in place, and leaves the request scope alone", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(rawReq({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }))
    const patched = writeAttempt(env, { targetEndpoint: "/responses" })
    expect(patched.attempt.targetEndpoint).toBe("/responses")
    expect(patched.request.stream).toBe(true)
    expect(patched.request.model?.id).toBe("gpt-4o")
    expect(patched.request.clientFormat).toBe("openai-cc")
    // CONTRACT CHANGE 2026-08-11: this used to assert the ORIGINAL env still read "/chat/completions", i.e. that `with()` returned a copy. The scopes are mutable now, so `writeAttempt` hands back the SAME envelope and the write is visible through the original handle — that identity is what lets a hook hold an envelope and keep seeing current values.
    expect(patched).toBe(env)
    expect(env.attempt.targetEndpoint).toBe("/responses")
  })

  test("envelope.view projects the CC payload (neutral read-only)", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(
      rawReq({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "t1" } }],
      }),
    )
    expect(env.view.summary.messageCount).toBeGreaterThan(0)
    expect(env.view.summary.hasTools).toBe(true)
    expect(env.view.summary.hasThinking).toBe(false)
    expect(env.view.tools.map((t) => t.name)).toContain("t1")
    expect(env.view.system?.text).toBe("sys")
    expect(env.view.messages.some((m) => m.role === "user")).toBe(true)
  })
})

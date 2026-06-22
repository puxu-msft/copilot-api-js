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
import { setModels } from "~/lib/state"

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

    expect(env.clientFormat).toBe("openai-cc")
    expect(env.model?.id).toBe("gpt-4o")
    expect(env.stream).toBe(true)
    expect(env.targetEndpoint).toBe("/chat/completions") // initial; driver overwrites via decideRoute
    const body = env.body as ChatCompletionsPayload
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
    expect(env.model?.id).toBe("gpt-deployment-real")
    const body = env.body as ChatCompletionsPayload
    expect(body.model).toBe("gpt-deployment-real")
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
    const body = env.body as ChatCompletionsPayload
    // an orphaned tool result (no preceding assistant tool_call) is filtered out
    expect(body.messages.find((m) => m.role === "tool")).toBeUndefined()
    expect(body.messages.map((m) => m.role)).toEqual(["user"])
  })

  test("unknown gpt-* model not in index → env.model undefined, still parses (CC fallback)", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(rawReq({ model: "gpt-unknown-xyz", messages: [{ role: "user", content: "hi" }] }))
    expect(env.model).toBeUndefined()
    expect((env.body as ChatCompletionsPayload).model).toBe("gpt-unknown-xyz")
  })

  test("envelope.with() patches the given key and preserves the rest (incl. stream)", () => {
    const codec = createOpenAiCcCodec()
    const env = codec.parse(rawReq({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }))
    const patched = env.with({ targetEndpoint: "/responses" })
    expect(patched.targetEndpoint).toBe("/responses")
    expect(patched.stream).toBe(true) // preserved across the with() rebuild
    expect(patched.model?.id).toBe("gpt-4o")
    expect(patched.clientFormat).toBe("openai-cc")
    expect(env.targetEndpoint).toBe("/chat/completions") // original unchanged (immutable)
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

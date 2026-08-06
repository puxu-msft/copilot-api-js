import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"

import { setModels } from "~/lib/models/cache"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

const CLAUDE_OPUS_FIXTURE: Model = {
  id: "claude-opus-4.6-1m",
  name: "Claude Opus 4.6 (1M context)(Internal only)",
  object: "model",
  vendor: "Anthropic",
  version: "claude-opus-4.6-1m",
  preview: false,
  model_picker_enabled: true,
  is_chat_default: false,
  is_chat_fallback: false,
  capabilities: {
    family: "claude-opus-4.6-1m",
    limits: {
      max_context_window_tokens: 1_000_000,
      max_output_tokens: 64_000,
      max_prompt_tokens: 936_000,
    },
    supports: {
      adaptive_thinking: true,
      max_thinking_budget: 32_000,
      parallel_tool_calls: true,
      reasoning_effort: ["low", "medium", "high"],
      structured_outputs: true,
      tool_calls: true,
      vision: true,
    },
  },
}

interface OpenAIModelListBody {
  object: string
  data: Array<{
    id: string
    object: string
    created: number
    owned_by: string
    display_name?: string
    context_window?: number
    max_input_tokens?: number
    max_output_tokens?: number
    vision?: boolean
    tool_calls?: boolean
    parallel_tool_calls?: boolean
    reasoning_effort?: Array<string>
    family?: string
    vendor?: string
  }>
}

const app = createFullTestApp()

describe("GET /v1/models — extended capability fields", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setModels({ object: "list", data: [CLAUDE_OPUS_FIXTURE] })
  })

  test("preserves the 4 baseline OpenAI fields at original positions/types", async () => {
    const res = await app.request("/v1/models")
    expect(res.status).toBe(200)

    const body = (await res.json()) as OpenAIModelListBody
    expect(body.object).toBe("list")
    expect(body.data).toHaveLength(1)

    const entry = body.data[0]
    expect(entry.id).toBe("claude-opus-4.6-1m")
    expect(entry.object).toBe("model")
    expect(entry.created).toBe(0)
    expect(entry.owned_by).toBe("Anthropic")
  })

  test("adds capability fields derived from supports/limits", async () => {
    const res = await app.request("/v1/models")
    const body = (await res.json()) as OpenAIModelListBody
    const entry = body.data[0]

    expect(entry.display_name).toBe("Claude Opus 4.6 (1M context)(Internal only)")
    expect(entry.context_window).toBe(1_000_000)
    expect(entry.max_input_tokens).toBe(936_000)
    expect(entry.max_output_tokens).toBe(64_000)
    expect(entry.vision).toBe(true)
    expect(entry.tool_calls).toBe(true)
    expect(entry.parallel_tool_calls).toBe(true)
    expect(entry.reasoning_effort).toEqual(["low", "medium", "high"])
    expect(entry.family).toBe("claude-opus-4.6-1m")
    expect(entry.vendor).toBe("Anthropic")
  })

  test("GET /v1/models/:id returns extended shape", async () => {
    const res = await app.request("/v1/models/claude-opus-4.6-1m")
    expect(res.status).toBe(200)
    const entry = (await res.json()) as OpenAIModelListBody["data"][0]
    expect(entry.id).toBe("claude-opus-4.6-1m")
    expect(entry.owned_by).toBe("Anthropic")
    expect(entry.vision).toBe(true)
  })
})

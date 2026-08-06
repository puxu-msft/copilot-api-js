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

// Real Copilot Claude entry from .claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json (first item)
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
  supported_endpoints: ["/v1/messages", "/chat/completions"],
  capabilities: {
    family: "claude-opus-4.6-1m",
    object: "model_capabilities",
    type: "chat",
    tokenizer: "o200k_base",
    limits: {
      max_context_window_tokens: 1_000_000,
      max_non_streaming_output_tokens: 16_000,
      max_output_tokens: 64_000,
      max_prompt_tokens: 936_000,
    },
    supports: {
      adaptive_thinking: true,
      max_thinking_budget: 32_000,
      min_thinking_budget: 1024,
      parallel_tool_calls: true,
      reasoning_effort: ["low", "medium", "high"],
      streaming: true,
      structured_outputs: true,
      tool_calls: true,
      vision: true,
    },
  },
}

const GPT_FIXTURE: Model = {
  id: "gpt-4o",
  name: "GPT-4o",
  object: "model",
  vendor: "OpenAI",
  version: "gpt-4o",
  preview: false,
  model_picker_enabled: true,
  is_chat_default: true,
  is_chat_fallback: false,
}

const app = createFullTestApp()

interface AnthropicCapability {
  supported: boolean
}

interface AnthropicCapabilityMatrix {
  image_input: AnthropicCapability
  structured_outputs: AnthropicCapability
  thinking: { supported: boolean; types: { adaptive: AnthropicCapability; enabled: AnthropicCapability } }
  effort: {
    supported: boolean
    low: AnthropicCapability
    medium: AnthropicCapability
    high: AnthropicCapability
    max: AnthropicCapability | null
    xhigh: AnthropicCapability | null
  }
  batch: AnthropicCapability
  citations: AnthropicCapability
  code_execution: AnthropicCapability
  pdf_input: AnthropicCapability
  context_management: { supported: boolean }
}

interface AnthropicListBody {
  data: Array<{
    id: string
    type: "model"
    display_name: string
    created_at: string
    max_input_tokens: number | null
    max_tokens: number | null
    capabilities: AnthropicCapabilityMatrix
  }>
  first_id: string | null
  has_more: boolean
  last_id: string | null
}

describe("GET /anthropic/v1/models", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setModels({ object: "list", data: [CLAUDE_OPUS_FIXTURE, GPT_FIXTURE] })
  })

  test("returns Anthropic-shape list filtered to vendor=Anthropic", async () => {
    const res = await app.request("/anthropic/v1/models")
    expect(res.status).toBe(200)

    const body = (await res.json()) as AnthropicListBody
    expect(body.data).toHaveLength(1)
    expect(body.first_id).toBe("claude-opus-4.6-1m")
    expect(body.last_id).toBe("claude-opus-4.6-1m")
    expect(body.has_more).toBe(false)

    const entry = body.data[0]
    expect(entry.id).toBe("claude-opus-4.6-1m")
    expect(entry.type).toBe("model")
    expect(entry.display_name).toBe("Claude Opus 4.6 (1M context)(Internal only)")
    expect(entry.max_input_tokens).toBe(936_000)
    expect(entry.max_tokens).toBe(64_000)
    expect(entry.created_at).toBe("1970-01-01T00:00:00Z")

    const caps = entry.capabilities
    expect(caps.image_input.supported).toBe(true)
    expect(caps.structured_outputs.supported).toBe(true)
    expect(caps.thinking.supported).toBe(true)
    expect(caps.thinking.types.adaptive.supported).toBe(true)
    expect(caps.thinking.types.enabled.supported).toBe(true)
    expect(caps.effort.supported).toBe(true)
    expect(caps.effort.low.supported).toBe(true)
    expect(caps.effort.medium.supported).toBe(true)
    expect(caps.effort.high.supported).toBe(true)
  })

  test("GET /:id returns the Anthropic shape for an Anthropic model", async () => {
    const res = await app.request("/anthropic/v1/models/claude-opus-4.6-1m")
    expect(res.status).toBe(200)

    const body = (await res.json()) as AnthropicListBody["data"][0]
    expect(body.id).toBe("claude-opus-4.6-1m")
    expect(body.type).toBe("model")
    expect(body.capabilities.image_input.supported).toBe(true)
  })

  test("GET /:id returns 404 for unknown id", async () => {
    const res = await app.request("/anthropic/v1/models/does-not-exist")
    expect(res.status).toBe(404)
  })

  test("GET /:id returns 404 for non-Anthropic vendor (consistent with list filter)", async () => {
    const res = await app.request("/anthropic/v1/models/gpt-4o")
    expect(res.status).toBe(404)
  })
})

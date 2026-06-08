import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"

import {
  //
  buildAnthropicModelsList,
  toAnthropicModelInfo,
  toOpenAIModelExtended,
} from "~/lib/models/capabilities-mapper"

function makeModel(overrides?: Partial<Model>): Model {
  return {
    id: "test-id",
    name: "Test Name",
    object: "model",
    vendor: "Anthropic",
    version: "1.0",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    ...overrides,
  }
}

// Real Copilot Claude entry — keep aligned with refs/AVAILABLE_MODELS.json (first entry)
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

describe("toOpenAIModelExtended", () => {
  test("preserves the 4 baseline fields untouched", () => {
    const out = toOpenAIModelExtended(CLAUDE_OPUS_FIXTURE)
    expect(out.id).toBe("claude-opus-4.6-1m")
    expect(out.object).toBe("model")
    expect(out.created).toBe(0)
    expect(out.owned_by).toBe("Anthropic")
  })

  test("derives capability fields from supports/limits", () => {
    const out = toOpenAIModelExtended(CLAUDE_OPUS_FIXTURE)
    expect(out.display_name).toBe("Claude Opus 4.6 (1M context)(Internal only)")
    expect(out.context_window).toBe(1_000_000)
    expect(out.max_input_tokens).toBe(936_000)
    expect(out.max_output_tokens).toBe(64_000)
    expect(out.vision).toBe(true)
    expect(out.tool_calls).toBe(true)
    expect(out.parallel_tool_calls).toBe(true)
    expect(out.reasoning_effort).toEqual(["low", "medium", "high"])
    expect(out.family).toBe("claude-opus-4.6-1m")
    expect(out.vendor).toBe("Anthropic")
  })

  test("omits capability fields when capabilities missing", () => {
    const out = toOpenAIModelExtended(makeModel({ vendor: "Anthropic", name: "x" }))
    expect(out.id).toBe("test-id")
    expect(out.owned_by).toBe("Anthropic")
    expect(out.vision).toBeUndefined()
    expect(out.tool_calls).toBeUndefined()
    expect(out.reasoning_effort).toBeUndefined()
    expect(out.context_window).toBeUndefined()
  })

  test("omits supports-derived fields when supports is empty", () => {
    const out = toOpenAIModelExtended(makeModel({ capabilities: { supports: {} } }))
    expect(out.vision).toBeUndefined()
    expect(out.tool_calls).toBeUndefined()
    expect(out.reasoning_effort).toBeUndefined()
  })
})

describe("toAnthropicModelInfo — derivation rules", () => {
  test("full Claude fixture maps to full capability matrix", () => {
    const info = toAnthropicModelInfo(CLAUDE_OPUS_FIXTURE)
    expect(info.id).toBe("claude-opus-4.6-1m")
    expect(info.type).toBe("model")
    expect(info.display_name).toBe("Claude Opus 4.6 (1M context)(Internal only)")
    expect(info.created_at).toBe("1970-01-01T00:00:00Z")
    expect(info.max_input_tokens).toBe(936_000)
    expect(info.max_tokens).toBe(64_000)

    const caps = info.capabilities
    expect(caps.image_input.supported).toBe(true)
    expect(caps.structured_outputs.supported).toBe(true)
    expect(caps.thinking.supported).toBe(true)
    expect(caps.thinking.types.adaptive.supported).toBe(true)
    expect(caps.thinking.types.enabled.supported).toBe(true)
    expect(caps.effort.supported).toBe(true)
    expect(caps.effort.low.supported).toBe(true)
    expect(caps.effort.medium.supported).toBe(true)
    expect(caps.effort.high.supported).toBe(true)
    expect(caps.effort.max.supported).toBe(false)
    expect(caps.effort.xhigh?.supported).toBe(false)
    expect(caps.batch.supported).toBe(false)
    expect(caps.citations.supported).toBe(false)
    expect(caps.code_execution.supported).toBe(false)
    expect(caps.pdf_input.supported).toBe(false)
    expect(caps.context_management.supported).toBe(false)
    expect(caps.context_management.clear_thinking_20251015?.supported).toBe(false)
    expect(caps.context_management.clear_tool_uses_20250919?.supported).toBe(false)
    expect(caps.context_management.compact_20260112?.supported).toBe(false)
  })

  test("image_input direct from supports.vision", () => {
    const yes = toAnthropicModelInfo(makeModel({ capabilities: { supports: { vision: true } } }))
    const no = toAnthropicModelInfo(makeModel({ capabilities: { supports: { vision: false } } }))
    expect(yes.capabilities.image_input.supported).toBe(true)
    expect(no.capabilities.image_input.supported).toBe(false)
  })

  test("structured_outputs is OR of structured_outputs and tool_calls", () => {
    const onlyTools = toAnthropicModelInfo(makeModel({ capabilities: { supports: { tool_calls: true } } }))
    expect(onlyTools.capabilities.structured_outputs.supported).toBe(true)

    const onlyStruct = toAnthropicModelInfo(makeModel({ capabilities: { supports: { structured_outputs: true } } }))
    expect(onlyStruct.capabilities.structured_outputs.supported).toBe(true)

    const neither = toAnthropicModelInfo(makeModel({ capabilities: { supports: {} } }))
    expect(neither.capabilities.structured_outputs.supported).toBe(false)
  })

  test("thinking.supported = adaptive_thinking OR max_thinking_budget>0", () => {
    const adaptive = toAnthropicModelInfo(makeModel({ capabilities: { supports: { adaptive_thinking: true } } }))
    expect(adaptive.capabilities.thinking.supported).toBe(true)
    expect(adaptive.capabilities.thinking.types.adaptive.supported).toBe(true)
    expect(adaptive.capabilities.thinking.types.enabled.supported).toBe(false)

    const budgeted = toAnthropicModelInfo(makeModel({ capabilities: { supports: { max_thinking_budget: 8000 } } }))
    expect(budgeted.capabilities.thinking.supported).toBe(true)
    expect(budgeted.capabilities.thinking.types.enabled.supported).toBe(true)
    expect(budgeted.capabilities.thinking.types.adaptive.supported).toBe(false)

    const zero = toAnthropicModelInfo(makeModel({ capabilities: { supports: { max_thinking_budget: 0 } } }))
    expect(zero.capabilities.thinking.supported).toBe(false)
    expect(zero.capabilities.thinking.types.enabled.supported).toBe(false)
  })

  test("effort levels populated from reasoning_effort array; empty array → unsupported", () => {
    const full = toAnthropicModelInfo(makeModel({ capabilities: { supports: { reasoning_effort: ["low", "max", "xhigh"] } } }))
    expect(full.capabilities.effort.supported).toBe(true)
    expect(full.capabilities.effort.low.supported).toBe(true)
    expect(full.capabilities.effort.medium.supported).toBe(false)
    expect(full.capabilities.effort.max.supported).toBe(true)
    expect(full.capabilities.effort.xhigh?.supported).toBe(true)

    const empty = toAnthropicModelInfo(makeModel({ capabilities: { supports: { reasoning_effort: [] } } }))
    expect(empty.capabilities.effort.supported).toBe(false)
  })

  test("effort.high derives from reasoning_effort containing 'high' in isolation", () => {
    const onlyHigh = toAnthropicModelInfo(makeModel({ capabilities: { supports: { reasoning_effort: ["high"] } } }))
    expect(onlyHigh.capabilities.effort.supported).toBe(true)
    expect(onlyHigh.capabilities.effort.high.supported).toBe(true)
    expect(onlyHigh.capabilities.effort.low.supported).toBe(false)
    expect(onlyHigh.capabilities.effort.medium.supported).toBe(false)
    expect(onlyHigh.capabilities.effort.max.supported).toBe(false)
    expect(onlyHigh.capabilities.effort.xhigh?.supported).toBe(false)
  })

  test("missing capabilities yields null limits and all-false matrix", () => {
    const info = toAnthropicModelInfo(makeModel({ capabilities: undefined }))
    expect(info.max_input_tokens).toBeNull()
    expect(info.max_tokens).toBeNull()
    expect(info.capabilities.image_input.supported).toBe(false)
    expect(info.capabilities.thinking.supported).toBe(false)
    expect(info.capabilities.effort.supported).toBe(false)
  })

  test("missing supports treated as empty", () => {
    const info = toAnthropicModelInfo(makeModel({ capabilities: { limits: { max_prompt_tokens: 1000 } } }))
    expect(info.max_input_tokens).toBe(1000)
    expect(info.capabilities.image_input.supported).toBe(false)
  })
})

describe("buildAnthropicModelsList", () => {
  const models: Array<Model> = [
    CLAUDE_OPUS_FIXTURE,
    makeModel({ id: "gpt-4o", vendor: "OpenAI", name: "GPT-4o" }),
    makeModel({ id: "gemini-2.5-pro", vendor: "Google", name: "Gemini 2.5 Pro" }),
  ]

  test("default vendorFilter = Anthropic", () => {
    const list = buildAnthropicModelsList(models)
    expect(list.data).toHaveLength(1)
    expect(list.data[0].id).toBe("claude-opus-4.6-1m")
    expect(list.first_id).toBe("claude-opus-4.6-1m")
    expect(list.last_id).toBe("claude-opus-4.6-1m")
    expect(list.has_more).toBe(false)
  })

  test("vendorFilter=all includes non-Anthropic models", () => {
    const list = buildAnthropicModelsList(models, { vendorFilter: "all" })
    expect(list.data).toHaveLength(3)
    expect(list.first_id).toBe("claude-opus-4.6-1m")
    expect(list.last_id).toBe("gemini-2.5-pro")
  })

  test("empty input yields null pagination cursors", () => {
    const list = buildAnthropicModelsList([])
    expect(list.data).toHaveLength(0)
    expect(list.first_id).toBeNull()
    expect(list.last_id).toBeNull()
  })

  test("vendor mismatch (no Anthropic) yields empty list with default filter", () => {
    const list = buildAnthropicModelsList([makeModel({ id: "gpt-4o", vendor: "OpenAI" })])
    expect(list.data).toHaveLength(0)
    expect(list.first_id).toBeNull()
  })
})

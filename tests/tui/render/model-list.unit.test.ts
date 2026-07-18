import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import stringWidth from "string-width"

import type { Model } from "~/lib/models/client"

import { formatAvailableModelLines } from "~/lib/tui/render/model-list"

function model(id: string, vendor: string, limits?: { context?: number; prompt?: number; output?: number }): Model {
  return {
    id,
    vendor,
    name: id,
    object: "model",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    is_chat_default: false,
    is_chat_fallback: false,
    capabilities:
      limits === undefined ? undefined : (
        {
          limits: {
            max_context_window_tokens: limits.context,
            max_prompt_tokens: limits.prompt,
            max_output_tokens: limits.output,
          },
        }
      ),
  } as Model
}

describe("formatAvailableModelLines", () => {
  test("empty catalogs produce no model rows", () => {
    expect(formatAvailableModelLines([])).toEqual([])
  })

  test("formats limits and aligns ordinary labels to the display-width column", () => {
    const lines = formatAvailableModelLines([
      { model: model("claude-opus-4.8", "Anthropic", { context: 1_000_000, prompt: 936_000, output: 64_000 }), disabled: false, billingLabel: "" },
      { model: model("模型-一", "Google", { context: 128_000, prompt: 64_000, output: 4_000 }), disabled: false, billingLabel: "" },
    ])

    expect(lines[0]).toContain("claude-opus-4.8 (Anthropic)")
    expect(lines[0]).toContain("ctx:1000k prp: 936k out:  64k")
    expect(lines[1]).toContain("模型-一 (Google)")
    const prefixWidths = lines.map((line) => stringWidth(line.slice(0, line.indexOf("ctx:"))))
    expect(new Set(prefixWidths).size).toBe(1)
  })

  test("never truncates long model identities or the disabled marker", () => {
    const id = "text-embedding-3-small-inference"
    const [line] = formatAvailableModelLines([{ model: model(id, "Azure OpenAI"), disabled: true, billingLabel: "" }])

    expect(line).toContain(`${id} (Azure OpenAI) [disabled]`)
    expect(line).not.toContain("...")
    expect(line).toContain("ctx:    ? prp:    ? out:    ?")
  })

  test("preserves billing labels without letting ANSI or code-unit length decide padding", () => {
    const [line] = formatAvailableModelLines([
      { model: model("claude-模型", "Anthropic", { context: 200_000, prompt: 168_000, output: 32_000 }), disabled: false, billingLabel: " (3x)" },
    ])

    expect(line).toContain("claude-模型 (3x) (Anthropic)")
    expect(stringWidth(line.slice(0, line.indexOf("ctx:")))).toBe(50)
  })
})

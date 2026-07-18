import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import stringWidth from "string-width"

import type { Model } from "~/lib/models/client"

import {
  //
  formatAvailableModelLines,
  renderModelCatalogLines,
} from "~/lib/tui/render/model-list"

// eslint-disable-next-line no-control-regex -- intentional terminal SGR.
const stripAnsi = (value: string): string => value.replaceAll(/\x1b\[[0-9;]*m/g, "")

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
    expect(formatAvailableModelLines([], { tokenBasedBilling: true })).toEqual([])
  })

  test("formats limits and aligns ordinary labels to the display-width column", () => {
    const lines = formatAvailableModelLines(
      [
        { model: model("claude-opus-4.8", "Anthropic", { context: 1_000_000, prompt: 936_000, output: 64_000 }), disabled: false },
        { model: model("模型-一", "Google", { context: 128_000, prompt: 64_000, output: 4_000 }), disabled: false },
      ],
      { tokenBasedBilling: true },
    )

    expect(stripAnsi(lines[0])).toContain("claude-opus-4.8 (Anthropic)")
    expect(stripAnsi(lines[0])).toContain("ctx:1000k prp: 936k out:  64k")
    expect(stripAnsi(lines[1])).toContain("模型-一 (Google)")
    const prefixWidths = lines.map((line) => stringWidth(line.slice(0, line.indexOf("ctx:"))))
    expect(new Set(prefixWidths).size).toBe(1)
  })

  test("never truncates long model identities or the disabled marker", () => {
    const id = "text-embedding-3-small-inference"
    const [line] = formatAvailableModelLines([{ model: model(id, "Azure OpenAI"), disabled: true }], { tokenBasedBilling: true })

    expect(line).toContain(`${id} (Azure OpenAI) [disabled]`)
    expect(line).not.toContain("...")
    expect(line).toContain("ctx:    ? prp:    ? out:    ?")
  })

  test("preserves billing labels without letting ANSI or code-unit length decide padding", () => {
    const [line] = formatAvailableModelLines(
      [{ model: { ...model("claude-模型", "Anthropic", { context: 200_000, prompt: 168_000, output: 32_000 }), billing: { multiplier: 3 } }, disabled: false }],
      { tokenBasedBilling: false },
    )

    expect(line).toContain("claude-模型 (3x) (Anthropic)")
    expect(stringWidth(line.slice(0, line.indexOf("ctx:")))).toBe(50)
  })

  test("catalog renderer adds the INFO header before model rows", () => {
    const lines = renderModelCatalogLines({
      models: [{ model: model("gpt-5.6-sol", "OpenAI"), disabled: false }],
      tokenBasedBilling: true,
      timeUnixMs: new Date("2023-11-14T14:25:36").getTime(),
    })
    expect(stripAnsi(lines[0])).toContain("[INFO]")
    expect(stripAnsi(lines[0])).toContain("14:25:36 Available models:")
    expect(stripAnsi(lines[1])).toContain("gpt-5.6-sol (OpenAI)")
  })

  test("FORCE_COLOR: disabled rows are gray and enabled >=900k context/prompt fields are yellow", () => {
    const script = `
      import { formatAvailableModelLines } from "./src/lib/tui/render/model-list.ts"
      const base = { name: "", object: "model", version: "1", model_picker_enabled: true, preview: false, is_chat_default: false, is_chat_fallback: false }
      const enabled = { ...base, id: "gpt-5.6-sol", vendor: "OpenAI", capabilities: { limits: { max_context_window_tokens: 1050000, max_prompt_tokens: 922000, max_output_tokens: 128000 } } }
      const boundary = { ...base, id: "boundary", vendor: "OpenAI", capabilities: { limits: { max_context_window_tokens: 900000, max_prompt_tokens: 899999, max_output_tokens: 128000 } } }
      const disabled = { ...base, id: "claude-opus-4.6", vendor: "Anthropic", capabilities: { limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 936000, max_output_tokens: 64000 } } }
      process.stdout.write(JSON.stringify(formatAvailableModelLines([{ model: enabled, disabled: false }, { model: boundary, disabled: false }, { model: disabled, disabled: true }], { tokenBasedBilling: true })))
    `
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "3" }, stdout: "pipe", stderr: "pipe" })
    expect(proc.exitCode).toBe(0)
    const [enabled, boundary, disabled] = JSON.parse(proc.stdout.toString()) as Array<string>

    expect(enabled).toContain("\x1b[33mctx:1050k\x1b[39m")
    expect(enabled).toContain("\x1b[33mprp: 922k\x1b[39m")
    expect(enabled).not.toContain("\x1b[33mout:")
    expect(boundary).toContain("\x1b[33mctx: 900k\x1b[39m")
    expect(boundary).not.toContain("\x1b[33mprp: 900k")
    expect(disabled.startsWith("\x1b[90m")).toBe(true)
    expect(disabled.endsWith("\x1b[39m")).toBe(true)
    expect(disabled).not.toContain("\x1b[33m")
  })
})

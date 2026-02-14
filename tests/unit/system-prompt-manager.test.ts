/**
 * Unit tests for system prompt manager: collection + config-based overrides.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  applyOverrides,
  loadConfig,
  processAnthropicSystem,
  processOpenAIMessages,
  resetConfigCache,
  type SystemPromptOverride,
} from "~/lib/config/system-prompt"
import { state } from "~/lib/state"

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string
let originalCollectSystemPrompts: boolean

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spm-test-"))
  const pathsMod = await import("~/lib/config/paths")
  ;(pathsMod.PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(pathsMod.PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  originalCollectSystemPrompts = state.collectSystemPrompts
  state.collectSystemPrompts = false
})

afterEach(async () => {
  state.collectSystemPrompts = originalCollectSystemPrompts
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ============================================================================
// applyOverrides
// ============================================================================

describe("applyOverrides", () => {
  // --- line method ---

  test("line: replaces a matching line", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "Hello world", to: "Goodbye world", method: "line" }]
    expect(applyOverrides("Hello world", overrides)).toBe("Goodbye world")
  })

  test("line: matches with leading/trailing whitespace on line", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "Hello world", to: "Goodbye", method: "line" }]
    expect(applyOverrides("  Hello world  ", overrides)).toBe("Goodbye")
  })

  test("line: no match leaves line unchanged", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "Hello world", to: "Goodbye", method: "line" }]
    expect(applyOverrides("Different text", overrides)).toBe("Different text")
  })

  test("line: only matching lines replaced in multiline text", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "line2", to: "REPLACED", method: "line" }]
    expect(applyOverrides("line1\nline2\nline3", overrides)).toBe("line1\nREPLACED\nline3")
  })

  test("line: multiline from does not match (per-line granularity)", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "line1\nline2", to: "REPLACED", method: "line" }]
    expect(applyOverrides("line1\nline2", overrides)).toBe("line1\nline2")
  })

  test("line: replaces each independently matching line", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "match", to: "HIT", method: "line" }]
    expect(applyOverrides("match\nno\nmatch", overrides)).toBe("HIT\nno\nHIT")
  })

  // --- regex method (full text, gms flags) ---

  test("regex: single replacement", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "foo", to: "bar", method: "regex" }]
    expect(applyOverrides("hello foo end", overrides)).toBe("hello bar end")
  })

  test("regex: global replacement (g flag)", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "foo", to: "bar", method: "regex" }]
    expect(applyOverrides("foo and foo", overrides)).toBe("bar and bar")
  })

  test("regex: matches across lines (full text)", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "target", to: "HIT", method: "regex" }]
    const input = "no match here\nhas target word\nalso target here"
    expect(applyOverrides(input, overrides)).toBe("no match here\nhas HIT word\nalso HIT here")
  })

  test("regex: dotAll flag allows . to match newlines", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "<tag>.*?</tag>", to: "", method: "regex" }]
    const input = "before <tag>\nmultiline\ncontent\n</tag> after"
    expect(applyOverrides(input, overrides)).toBe("before  after")
  })

  test("regex: ^ and $ match line boundaries (m flag)", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "^remove this line$", to: "", method: "regex" }]
    const input = "keep this\nremove this line\nkeep this too"
    expect(applyOverrides(input, overrides)).toBe("keep this\n\nkeep this too")
  })

  test("regex: ^$ line matching with capture groups", () => {
    const overrides: Array<SystemPromptOverride> = [
      { from: String.raw`^(IMPORTANT:[^\n]*)$`, to: "[$1]", method: "regex" },
    ]
    const input = "normal line\nIMPORTANT: do something\nanother line"
    expect(applyOverrides(input, overrides)).toBe("normal line\n[IMPORTANT: do something]\nanother line")
  })

  test("regex: capture group placeholders $1 $2", () => {
    const overrides: Array<SystemPromptOverride> = [
      { from: String.raw`(\w+) is (\w+)`, to: "$2 is $1", method: "regex" },
    ]
    expect(applyOverrides("cat is big", overrides)).toBe("big is cat")
  })

  test("regex: invalid regex silently skips", () => {
    const overrides: Array<SystemPromptOverride> = [{ from: "[invalid(", to: "replacement", method: "regex" }]
    expect(applyOverrides("original text", overrides)).toBe("original text")
  })

  // --- mixed ---

  test("multiple rules applied in order", () => {
    const overrides: Array<SystemPromptOverride> = [
      { from: "aaa", to: "bbb", method: "regex" },
      { from: "bbb", to: "ccc", method: "regex" },
    ]
    expect(applyOverrides("aaa", overrides)).toBe("ccc")
  })

  test("line and regex rules can be mixed", () => {
    const overrides: Array<SystemPromptOverride> = [
      { from: "exact line", to: "REPLACED", method: "line" },
      { from: "partial", to: "MATCHED", method: "regex" },
    ]
    const input = "exact line\nhas partial word"
    expect(applyOverrides(input, overrides)).toBe("REPLACED\nhas MATCHED word")
  })
})

// ============================================================================
// loadConfig
// ============================================================================

describe("loadConfig", () => {
  test("returns empty config when file does not exist", async () => {
    const config = await loadConfig()
    expect(config).toEqual({})
  })

  test("parses valid YAML config", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "hello"
    to: "world"
    method: line
`,
    )
    const config = await loadConfig()
    expect(config.system_prompt_overrides).toHaveLength(1)
    expect(config.system_prompt_overrides![0]).toEqual({
      from: "hello",
      to: "world",
      method: "line",
    })
  })

  test("returns empty config on invalid YAML (warns)", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, ":\n  :\n    : [invalid")
    const config = await loadConfig()
    expect(config).toBeDefined()
  })

  test("caches config by mtime", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "a"
    to: "b"
    method: line
`,
    )
    const config1 = await loadConfig()
    const config2 = await loadConfig()
    expect(config1).toBe(config2)
  })

  test("reloads config when mtime changes", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "a"
    to: "b"
    method: line
`,
    )
    const config1 = await loadConfig()

    await new Promise((r) => setTimeout(r, 50))
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "x"
    to: "y"
    method: regex
`,
    )
    resetConfigCache()
    const config2 = await loadConfig()
    expect(config2.system_prompt_overrides![0].from).toBe("x")
    expect(config1).not.toBe(config2)
  })
})

// ============================================================================
// collectSystemPrompt (opt-in via state.collectSystemPrompts)
// ============================================================================

describe("collectSystemPrompt", () => {
  test("does not collect when collectSystemPrompts is false", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    state.collectSystemPrompts = false
    await processAnthropicSystem("test system prompt")
    await new Promise((r) => setTimeout(r, 100))

    const files = await fs.readdir(PATHS.APP_DIR)
    const promptFiles = files.filter((f) => f.startsWith("system_prompts_"))
    expect(promptFiles).toHaveLength(0)
  })

  test("creates file on first encounter when enabled", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    state.collectSystemPrompts = true
    await processAnthropicSystem("test system prompt")
    await new Promise((r) => setTimeout(r, 100))

    const files = await fs.readdir(PATHS.APP_DIR)
    const promptFiles = files.filter((f) => f.startsWith("system_prompts_"))
    expect(promptFiles).toHaveLength(1)

    const content = JSON.parse(await fs.readFile(path.join(PATHS.APP_DIR, promptFiles[0])))
    expect(content.format).toBe("anthropic")
    expect(content.hash).toBeDefined()
    expect(content.timestamp).toBeDefined()
    expect(content.raw).toBe("test system prompt")
  })

  test("skips writing when file already exists (dedup)", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    state.collectSystemPrompts = true
    await processAnthropicSystem("same prompt")
    await new Promise((r) => setTimeout(r, 100))
    await processAnthropicSystem("same prompt")
    await new Promise((r) => setTimeout(r, 100))

    const files = await fs.readdir(PATHS.APP_DIR)
    const promptFiles = files.filter((f) => f.startsWith("system_prompts_"))
    expect(promptFiles).toHaveLength(1)
  })

  test("creates separate files for different prompts", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    state.collectSystemPrompts = true
    await processAnthropicSystem("prompt A")
    await processAnthropicSystem("prompt B")
    await new Promise((r) => setTimeout(r, 100))

    const files = await fs.readdir(PATHS.APP_DIR)
    const promptFiles = files.filter((f) => f.startsWith("system_prompts_"))
    expect(promptFiles).toHaveLength(2)
  })

  test("JSON content has correct format for Anthropic TextBlock[]", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    state.collectSystemPrompts = true
    const blocks = [
      { type: "text" as const, text: "block one" },
      { type: "text" as const, text: "block two" },
    ]
    await processAnthropicSystem(blocks)
    await new Promise((r) => setTimeout(r, 100))

    const files = await fs.readdir(PATHS.APP_DIR)
    const promptFile = files.find((f) => f.startsWith("system_prompts_"))!
    const content = JSON.parse(await fs.readFile(path.join(PATHS.APP_DIR, promptFile)))
    expect(content.format).toBe("anthropic")
    expect(content.raw).toEqual(blocks)
  })

  test("JSON content has correct format for OpenAI", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    state.collectSystemPrompts = true
    const messages = [
      { role: "system" as const, content: "system msg" },
      { role: "user" as const, content: "user msg" },
    ]
    await processOpenAIMessages(messages)
    await new Promise((r) => setTimeout(r, 100))

    const files = await fs.readdir(PATHS.APP_DIR)
    const promptFile = files.find((f) => f.startsWith("system_prompts_"))!
    const content = JSON.parse(await fs.readFile(path.join(PATHS.APP_DIR, promptFile)))
    expect(content.format).toBe("openai")
    expect(content.raw).toEqual([{ role: "system", content: "system msg" }])
  })
})

// ============================================================================
// processAnthropicSystem
// ============================================================================

describe("processAnthropicSystem", () => {
  test("returns undefined for undefined input", async () => {
    expect(await processAnthropicSystem(undefined)).toBeUndefined()
  })

  test("returns string unchanged when no config", async () => {
    const result = await processAnthropicSystem("original prompt")
    expect(result).toBe("original prompt")
  })

  test("applies line overrides to string system prompt", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "bad line"
    to: ""
    method: line
`,
    )
    const result = await processAnthropicSystem("good line\nbad line\nanother good line")
    expect(result).toBe("good line\n\nanother good line")
  })

  test("applies regex overrides per block in TextBlock[]", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "remove me"
    to: ""
    method: regex
`,
    )
    const blocks = [
      { type: "text" as const, text: "block with remove me inside" },
      { type: "text" as const, text: "clean block" },
    ]
    const result = (await processAnthropicSystem(blocks)) as Array<{ type: string; text: string }>
    expect(result[0].text).toBe("block with  inside")
    expect(result[1].text).toBe("clean block")
  })

  test("preserves extra properties on TextBlock (e.g. cache_control)", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "old"
    to: "new"
    method: regex
`,
    )
    const blocks = [{ type: "text" as const, text: "old content", cache_control: { type: "ephemeral" as const } }]
    const result = (await processAnthropicSystem(blocks)) as typeof blocks
    expect(result[0].text).toBe("new content")
    expect(result[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("prepends text to string system prompt", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_prepend: "PREFIX"\n')
    const result = await processAnthropicSystem("original")
    expect(result).toBe("PREFIX\n\noriginal")
  })

  test("prepends TextBlock to TextBlock[] system prompt", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_prepend: "PREFIX"\n')
    const blocks = [{ type: "text" as const, text: "original" }]
    const result = (await processAnthropicSystem(blocks)) as Array<{ type: string; text: string }>
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe("PREFIX")
    expect(result[1].text).toBe("original")
  })

  test("appends text to string system prompt", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_append: "SUFFIX"\n')
    const result = await processAnthropicSystem("original")
    expect(result).toBe("original\n\nSUFFIX")
  })

  test("appends TextBlock to TextBlock[] system prompt", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_append: "SUFFIX"\n')
    const blocks = [{ type: "text" as const, text: "original" }]
    const result = (await processAnthropicSystem(blocks)) as Array<{ type: string; text: string }>
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe("original")
    expect(result[1].text).toBe("SUFFIX")
  })

  test("prepend and append together on string", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_prepend: "PRE"\nsystem_prompt_append: "POST"\n')
    const result = await processAnthropicSystem("middle")
    expect(result).toBe("PRE\n\nmiddle\n\nPOST")
  })
})

// ============================================================================
// processOpenAIMessages
// ============================================================================

describe("processOpenAIMessages", () => {
  test("returns messages unchanged when no system messages", async () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]
    const result = await processOpenAIMessages(messages)
    expect(result).toEqual(messages)
  })

  test("applies overrides to string content system message", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "forbidden"
    to: "allowed"
    method: regex
`,
    )
    const messages = [
      { role: "system" as const, content: "This is forbidden content" },
      { role: "user" as const, content: "hello" },
    ]
    const result = await processOpenAIMessages(messages)
    expect(result[0].content).toBe("This is allowed content")
    expect(result[1].content).toBe("hello")
  })

  test("applies overrides to ContentPart[] system message", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "secret"
    to: "public"
    method: regex
`,
    )
    const messages = [
      {
        role: "system" as const,
        content: [
          { type: "text" as const, text: "This is secret info" },
          { type: "text" as const, text: "No secret here wait secret" },
        ],
      },
      { role: "user" as const, content: "hello" },
    ]
    const result = await processOpenAIMessages(messages)
    const sysContent = result[0].content as Array<{ type: string; text: string }>
    expect(sysContent[0].text).toBe("This is public info")
    expect(sysContent[1].text).toBe("No public here wait public")
  })

  test("does not modify non-system messages", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "target"
    to: "replaced"
    method: regex
`,
    )
    const messages = [
      { role: "system" as const, content: "target in system" },
      { role: "user" as const, content: "target in user" },
      { role: "assistant" as const, content: "target in assistant" },
    ]
    const result = await processOpenAIMessages(messages)
    expect(result[0].content).toBe("replaced in system")
    expect(result[1].content).toBe("target in user")
    expect(result[2].content).toBe("target in assistant")
  })

  test("processes developer role messages", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "restricted"
    to: "open"
    method: regex
`,
    )
    const messages = [
      { role: "developer" as const, content: "restricted instructions" },
      { role: "user" as const, content: "hello" },
    ]
    const result = await processOpenAIMessages(messages)
    expect(result[0].content).toBe("open instructions")
  })

  test("handles null content gracefully", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "x"
    to: "y"
    method: regex
`,
    )
    const messages = [
      { role: "system" as const, content: null },
      { role: "user" as const, content: "hello" },
    ]
    const result = await processOpenAIMessages(messages)
    expect(result[0].content).toBeNull()
  })

  test("prepends system message when configured", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_prepend: "PREFIX"\n')
    const messages = [{ role: "user" as const, content: "hello" }]
    const result = await processOpenAIMessages(messages)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: "system", content: "PREFIX" })
    expect(result[1]).toEqual({ role: "user", content: "hello" })
  })

  test("appends system message when configured", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_append: "SUFFIX"\n')
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hello" },
    ]
    const result = await processOpenAIMessages(messages)
    expect(result).toHaveLength(3)
    expect(result[0].content).toBe("sys")
    expect(result[1].content).toBe("hello")
    expect(result[2]).toEqual({ role: "system", content: "SUFFIX" })
  })

  test("prepends and appends when both configured", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_prepend: "PREFIX"\nsystem_prompt_append: "SUFFIX"\n')
    const messages = [{ role: "user" as const, content: "hello" }]
    const result = await processOpenAIMessages(messages)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ role: "system", content: "PREFIX" })
    expect(result[1]).toEqual({ role: "user", content: "hello" })
    expect(result[2]).toEqual({ role: "system", content: "SUFFIX" })
  })
})

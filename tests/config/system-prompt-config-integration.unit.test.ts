/**
 * Integration-style unit tests for config-driven system prompt processing.
 *
 * Covers both config loading/compilation and `~/lib/system-prompt` behavior.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  compileRewriteRules,
  compileScope,
  compileSystemPromptEntries,
  loadConfig,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
  type RewriteRule,
} from "~/lib/config/config"
import { setAnthropicBehavior } from "~/lib/state"
import {
  //
  applyOverrides,
  processAnthropicSystem,
  processOpenAIMessages,
  processResponsesInstructions,
} from "~/lib/system-prompt"

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string
let originalAppDir: string
let originalConfigYaml: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spm-test-"))
  const pathsMod = await import("~/lib/config/paths")
  originalAppDir = pathsMod.PATHS.APP_DIR
  originalConfigYaml = pathsMod.PATHS.CONFIG_YAML
  ;(pathsMod.PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(pathsMod.PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  // Clear compiled system-prompt state. `applyConfigToState` is retain-on-absence
  // (a config missing a key keeps the prior state — correct for hot-reload), and
  // `resetApplyState` only clears the applied flag, so without this the compiled
  // overrides/prepend/append leak across tests.
  setAnthropicBehavior({ systemPromptOverrides: [], systemPromptPrepend: [], systemPromptAppend: [] })
  // Isolate from real bundled config — these tests assert raw load semantics.
  setBundledConfigForTests({})
})

afterEach(async () => {
  const pathsMod = await import("~/lib/config/paths")
  ;(pathsMod.PATHS as { APP_DIR: string }).APP_DIR = originalAppDir
  ;(pathsMod.PATHS as { CONFIG_YAML: string }).CONFIG_YAML = originalConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  setBundledConfigForTests(null)
})

// ============================================================================
// applyOverrides
// ============================================================================

/** Shorthand: compile raw rules for applyOverrides tests */
const compile = (...raws: Array<RewriteRule>) => compileRewriteRules(raws)

describe("applyOverrides", () => {
  // --- line method ---

  test("line: replaces a matching line", () => {
    expect(applyOverrides("Hello world", compile({ from: "Hello world", to: "Goodbye world", method: "line" }))).toBe("Goodbye world")
  })

  test("line: matches with leading/trailing whitespace on line", () => {
    expect(applyOverrides("  Hello world  ", compile({ from: "Hello world", to: "Goodbye", method: "line" }))).toBe("Goodbye")
  })

  test("line: no match leaves line unchanged", () => {
    expect(applyOverrides("Different text", compile({ from: "Hello world", to: "Goodbye", method: "line" }))).toBe("Different text")
  })

  test("line: only matching lines replaced in multiline text", () => {
    expect(applyOverrides("line1\nline2\nline3", compile({ from: "line2", to: "REPLACED", method: "line" }))).toBe("line1\nREPLACED\nline3")
  })

  test("line: multiline from does not match (per-line granularity)", () => {
    expect(applyOverrides("line1\nline2", compile({ from: "line1\nline2", to: "REPLACED", method: "line" }))).toBe("line1\nline2")
  })

  test("line: replaces each independently matching line", () => {
    expect(applyOverrides("match\nno\nmatch", compile({ from: "match", to: "HIT", method: "line" }))).toBe("HIT\nno\nHIT")
  })

  // --- regex method (full text, gms flags) ---

  test("regex: single replacement", () => {
    expect(applyOverrides("hello foo end", compile({ from: "foo", to: "bar", method: "regex" }))).toBe("hello bar end")
  })

  test("regex: global replacement (g flag)", () => {
    expect(applyOverrides("foo and foo", compile({ from: "foo", to: "bar", method: "regex" }))).toBe("bar and bar")
  })

  test("regex: matches across lines (full text)", () => {
    const input = "no match here\nhas target word\nalso target here"
    expect(applyOverrides(input, compile({ from: "target", to: "HIT", method: "regex" }))).toBe("no match here\nhas HIT word\nalso HIT here")
  })

  test("regex: dotAll flag allows . to match newlines", () => {
    const input = "before <tag>\nmultiline\ncontent\n</tag> after"
    expect(applyOverrides(input, compile({ from: "<tag>.*?</tag>", to: "", method: "regex" }))).toBe("before  after")
  })

  test("regex: ^ and $ match line boundaries (m flag)", () => {
    const input = "keep this\nremove this line\nkeep this too"
    expect(applyOverrides(input, compile({ from: "^remove this line$", to: "", method: "regex" }))).toBe("keep this\n\nkeep this too")
  })

  test("regex: ^$ line matching with capture groups", () => {
    const input = "normal line\nIMPORTANT: do something\nanother line"
    expect(applyOverrides(input, compile({ from: String.raw`^(IMPORTANT:[^\n]*)$`, to: "[$1]", method: "regex" }))).toBe(
      "normal line\n[IMPORTANT: do something]\nanother line",
    )
  })

  test("regex: capture group placeholders $1 $2", () => {
    expect(applyOverrides("cat is big", compile({ from: String.raw`(\w+) is (\w+)`, to: "$2 is $1", method: "regex" }))).toBe("big is cat")
  })

  // --- mixed ---

  test("multiple rules applied in order", () => {
    expect(applyOverrides("aaa", compile({ from: "aaa", to: "bbb", method: "regex" }, { from: "bbb", to: "ccc", method: "regex" }))).toBe("ccc")
  })

  test("line and regex rules can be mixed", () => {
    const input = "exact line\nhas partial word"
    expect(applyOverrides(input, compile({ from: "exact line", to: "REPLACED", method: "line" }, { from: "partial", to: "MATCHED", method: "regex" }))).toBe(
      "REPLACED\nhas MATCHED word",
    )
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

// ============================================================================
// Model filtering in applyOverrides
// ============================================================================

describe("applyOverrides — model filtering", () => {
  test("rule with matching model pattern is applied", () => {
    const rules = compile({ from: "foo", to: "bar", model: "opus" })
    expect(applyOverrides("foo", rules, "claude-opus-4.6")).toBe("bar")
  })

  test("rule with non-matching model pattern is skipped", () => {
    const rules = compile({ from: "foo", to: "bar", model: "opus" })
    expect(applyOverrides("foo", rules, "claude-sonnet-4.5")).toBe("foo")
  })

  test("rule without model pattern applies to all models", () => {
    const rules = compile({ from: "foo", to: "bar" })
    expect(applyOverrides("foo", rules, "claude-opus-4.6")).toBe("bar")
    expect(applyOverrides("foo", rules, "claude-sonnet-4.5")).toBe("bar")
  })

  test("rule with model pattern is skipped when no model is passed", () => {
    const rules = compile({ from: "foo", to: "bar", model: "opus" })
    expect(applyOverrides("foo", rules)).toBe("foo")
  })

  test("model pattern matching is case-insensitive", () => {
    const rules = compile({ from: "foo", to: "bar", model: "OPUS" })
    expect(applyOverrides("foo", rules, "claude-opus-4.6")).toBe("bar")
  })

  test("model pattern supports regex anchors", () => {
    const rules = compile({ from: "foo", to: "bar", model: "^claude-sonnet" })
    expect(applyOverrides("foo", rules, "claude-sonnet-4.5")).toBe("bar")
    expect(applyOverrides("foo", rules, "my-claude-sonnet")).toBe("foo")
  })

  test("mixed rules: model-filtered and universal rules coexist", () => {
    const rules = compile({ from: "aaa", to: "AAA", model: "opus" }, { from: "bbb", to: "BBB" })
    // sonnet: only universal rule applies
    expect(applyOverrides("aaa bbb", rules, "claude-sonnet-4.5")).toBe("aaa BBB")
    // opus: both rules apply
    expect(applyOverrides("aaa bbb", rules, "claude-opus-4.6")).toBe("AAA BBB")
  })

  test("model filter works with line method", () => {
    const rules = compile({ from: "exact line", to: "REPLACED", method: "line", model: "opus" })
    expect(applyOverrides("exact line", rules, "claude-opus-4.6")).toBe("REPLACED")
    expect(applyOverrides("exact line", rules, "claude-sonnet-4.5")).toBe("exact line")
  })
})

// ============================================================================
// compileRewriteRule — model regex compilation
// ============================================================================

describe("compileRewriteRule — model regex", () => {
  test("valid model regex is compiled to modelPattern", () => {
    const rules = compileRewriteRules([{ from: "a", to: "b", model: "opus" }])
    expect(rules).toHaveLength(1)
    expect(rules[0].modelPattern).toBeInstanceOf(RegExp)
    expect(rules[0].modelPattern!.test("claude-opus-4.6")).toBe(true)
    expect(rules[0].modelPattern!.test("claude-sonnet-4.5")).toBe(false)
  })

  test("invalid model regex skips the entire rule", () => {
    const rules = compileRewriteRules([{ from: "a", to: "b", model: "[invalid" }])
    expect(rules).toHaveLength(0)
  })

  test("rule without model has no modelPattern", () => {
    const rules = compileRewriteRules([{ from: "a", to: "b" }])
    expect(rules).toHaveLength(1)
    expect(rules[0].modelPattern).toBeUndefined()
  })

  test("model regex is compiled for line method too", () => {
    const rules = compileRewriteRules([{ from: "a", to: "b", method: "line", model: "haiku" }])
    expect(rules).toHaveLength(1)
    expect(rules[0].modelPattern).toBeInstanceOf(RegExp)
    expect(rules[0].method).toBe("line")
  })
})

// ============================================================================
// Endpoint scope — compileScope
// ============================================================================

describe("compileScope — endpoint axis", () => {
  test("single endpoint compiles to a one-element set", () => {
    const scope = compileScope({ endpoint: "anthropic" })
    expect(scope).not.toBeNull()
    expect([...scope!.endpointSet!]).toEqual(["anthropic"])
  })

  test("endpoint array compiles to a set of all", () => {
    const scope = compileScope({ endpoint: ["anthropic", "gemini"] })
    expect(scope).not.toBeNull()
    expect(scope!.endpointSet!.has("anthropic")).toBe(true)
    expect(scope!.endpointSet!.has("gemini")).toBe(true)
    expect(scope!.endpointSet!.has("openai-cc")).toBe(false)
  })

  test("no endpoint leaves endpointSet undefined", () => {
    const scope = compileScope({ model: "opus" })
    expect(scope!.endpointSet).toBeUndefined()
  })

  test("invalid model regex returns null (skips rule/entry)", () => {
    expect(compileScope({ model: "[invalid" })).toBeNull()
  })

  test("both axes compile together", () => {
    const scope = compileScope({ model: "opus", endpoint: "anthropic" })
    expect(scope!.modelPattern).toBeInstanceOf(RegExp)
    expect(scope!.endpointSet!.has("anthropic")).toBe(true)
  })
})

// ============================================================================
// applyOverrides — endpoint filtering + two-axis AND
// ============================================================================

describe("applyOverrides — endpoint filtering", () => {
  test("rule with matching endpoint is applied", () => {
    const rules = compileRewriteRules([{ from: "foo", to: "bar", endpoint: "anthropic" }])
    expect(applyOverrides("foo", rules, undefined, "anthropic")).toBe("bar")
  })

  test("rule with non-matching endpoint is skipped", () => {
    const rules = compileRewriteRules([{ from: "foo", to: "bar", endpoint: "anthropic" }])
    expect(applyOverrides("foo", rules, undefined, "openai-cc")).toBe("foo")
  })

  test("rule with endpoint scope is skipped when no endpoint is passed", () => {
    const rules = compileRewriteRules([{ from: "foo", to: "bar", endpoint: "anthropic" }])
    expect(applyOverrides("foo", rules)).toBe("foo")
  })

  test("rule without endpoint applies to all endpoints", () => {
    const rules = compileRewriteRules([{ from: "foo", to: "bar" }])
    expect(applyOverrides("foo", rules, undefined, "anthropic")).toBe("bar")
    expect(applyOverrides("foo", rules, undefined, "gemini")).toBe("bar")
  })

  test("endpoint array matches any member", () => {
    const rules = compileRewriteRules([{ from: "foo", to: "bar", endpoint: ["anthropic", "gemini"] }])
    expect(applyOverrides("foo", rules, undefined, "gemini")).toBe("bar")
    expect(applyOverrides("foo", rules, undefined, "openai-cc")).toBe("foo")
  })

  test("two-axis AND: both model and endpoint must match", () => {
    const rules = compileRewriteRules([{ from: "foo", to: "bar", model: "opus", endpoint: "anthropic" }])
    // both match
    expect(applyOverrides("foo", rules, "claude-opus-4.6", "anthropic")).toBe("bar")
    // model matches, endpoint doesn't
    expect(applyOverrides("foo", rules, "claude-opus-4.6", "openai-cc")).toBe("foo")
    // endpoint matches, model doesn't
    expect(applyOverrides("foo", rules, "claude-sonnet-4.5", "anthropic")).toBe("foo")
  })
})

// ============================================================================
// compileSystemPromptEntries
// ============================================================================

describe("compileSystemPromptEntries", () => {
  test("undefined → empty list", () => {
    expect(compileSystemPromptEntries(undefined)).toEqual([])
  })

  test("plain string → single unscoped entry", () => {
    const entries = compileSystemPromptEntries("PREFIX")
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe("PREFIX")
    expect(entries[0].modelPattern).toBeUndefined()
    expect(entries[0].endpointSet).toBeUndefined()
  })

  test("single entry object → one scoped entry", () => {
    const entries = compileSystemPromptEntries({ text: "T", model: "opus", endpoint: "anthropic" })
    expect(entries).toHaveLength(1)
    expect(entries[0].modelPattern).toBeInstanceOf(RegExp)
    expect(entries[0].endpointSet!.has("anthropic")).toBe(true)
  })

  test("entry array → multiple entries preserving order", () => {
    const entries = compileSystemPromptEntries([{ text: "A" }, { text: "B", endpoint: "gemini" }])
    expect(entries.map((e) => e.text)).toEqual(["A", "B"])
    expect(entries[1].endpointSet!.has("gemini")).toBe(true)
  })

  test("entry with invalid model regex is skipped", () => {
    const entries = compileSystemPromptEntries([{ text: "A" }, { text: "bad", model: "[invalid" }])
    expect(entries.map((e) => e.text)).toEqual(["A"])
  })
})

// ============================================================================
// Endpoint differentiation through the processors (end-to-end via config)
// ============================================================================

describe("endpoint-scoped prepend/append through processors", () => {
  test("prepend entry with endpoint scope only fires on the matching endpoint", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_prepend:
  - text: "ANTHROPIC-ONLY"
    endpoint: anthropic
`,
    )
    // Anthropic endpoint → prepend applied
    expect(await processAnthropicSystem("orig", undefined, "anthropic")).toBe("ANTHROPIC-ONLY\n\norig")
    // Responses endpoint → prepend NOT applied
    expect(await processResponsesInstructions("orig", undefined, "openai-responses")).toBe("orig")
  })

  test("multiple scoped prepend entries concatenate top-down for a matching endpoint", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_prepend:
  - text: "ALL"
  - text: "CC-ONLY"
    endpoint: openai-cc
`,
    )
    const messages = [{ role: "user" as const, content: "hi" }]
    const result = await processOpenAIMessages(messages, undefined, "openai-cc")
    // Both entries match on openai-cc → joined with "\n\n"
    expect(result[0]).toEqual({ role: "system", content: "ALL\n\nCC-ONLY" })
  })

  test("append entry scoped to an endpoint array fires for any member", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_append:
  - text: "MULTI"
    endpoint: [anthropic, gemini]
`,
    )
    expect(await processAnthropicSystem("orig", undefined, "anthropic")).toBe("orig\n\nMULTI")
    // gemini goes through processOpenAIMessages
    const result = await processOpenAIMessages([{ role: "system" as const, content: "sys" }], undefined, "gemini")
    expect(result.at(-1)).toEqual({ role: "system", content: "MULTI" })
    // openai-cc is NOT in the set → no append
    const ccResult = await processOpenAIMessages([{ role: "system" as const, content: "sys" }], undefined, "openai-cc")
    expect(ccResult).toHaveLength(1)
  })

  test("model + endpoint AND scope on prepend", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_prepend:
  - text: "OPUS-ANTHROPIC"
    model: opus
    endpoint: anthropic
`,
    )
    expect(await processAnthropicSystem("orig", "claude-opus-4.6", "anthropic")).toBe("OPUS-ANTHROPIC\n\norig")
    // wrong model → skip
    expect(await processAnthropicSystem("orig", "claude-sonnet-4.5", "anthropic")).toBe("orig")
    // wrong endpoint → skip
    expect(await processResponsesInstructions("orig", "claude-opus-4.6", "openai-responses")).toBe("orig")
  })
})

// ============================================================================
// Schema parsing — endpoint + entry-list forms
// ============================================================================

describe("loadConfig — endpoint scope + prepend/append forms", () => {
  test("parses rewrite rule with endpoint field", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "a"
    to: "b"
    endpoint: anthropic
`,
    )
    const config = await loadConfig()
    expect(config.system_prompt_overrides![0].endpoint).toBe("anthropic")
  })

  test("parses prepend as a plain string (backward compat)", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(PATHS.CONFIG_YAML, 'system_prompt_prepend: "LEGACY"\n')
    const config = await loadConfig()
    expect(config.system_prompt_prepend).toBe("LEGACY")
  })

  test("parses prepend as an entry list", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_prepend:
  - text: "X"
    endpoint: [openai-cc, openai-responses]
`,
    )
    const config = await loadConfig()
    expect(Array.isArray(config.system_prompt_prepend)).toBe(true)
    const entries = config.system_prompt_prepend as Array<{ text: string; endpoint: Array<string> }>
    expect(entries[0].text).toBe("X")
    expect(entries[0].endpoint).toEqual(["openai-cc", "openai-responses"])
  })

  test("invalid endpoint value is stripped (warns, does not throw)", async () => {
    const { PATHS } = await import("~/lib/config/paths")
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `system_prompt_overrides:
  - from: "a"
    to: "b"
    endpoint: not-a-real-endpoint
`,
    )
    const config = await loadConfig()
    // Loader strips the invalid field/rule and continues (warn-and-continue).
    expect(config).toBeDefined()
  })
})

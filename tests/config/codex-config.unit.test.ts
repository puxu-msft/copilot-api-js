/**
 * Unit tests for the Codex `config.toml` managed-block writer.
 *
 * `applyCodexConfig` is a pure function (no fs), so these tests exercise the
 * full algorithm — first creation, idempotent block replacement, byte-for-byte
 * preservation of user content outside the markers, duplicate-key guard, and
 * legacy-block migration — without touching the real filesystem.
 *
 * `atomicWriteText` is exercised against an injected temp directory.
 */

import {
  //
  afterAll,
  describe,
  expect,
  test,
} from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { atomicWriteText } from "~/lib/atomic-fs"
import { applyCodexConfig } from "~/lib/codex-config"

const BASE_URL = "http://localhost:4141/v1"

const BEGIN_MARK = "# >>> copilot-api managed block — auto-generated, do not edit between markers >>>"
const END_MARK = "# <<< copilot-api managed block — edits outside this block are preserved <<<"

describe("applyCodexConfig — first creation", () => {
  test("creates a managed block from empty content", () => {
    const { content, changed } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: "" })
    expect(changed).toBe(true)
    expect(content).toContain(BEGIN_MARK)
    expect(content).toContain(END_MARK)
    expect(content).toContain(`model_provider = "ghc"`)
    expect(content).toContain(`[model_providers.ghc]`)
    expect(content).toContain(`base_url = "${BASE_URL}"`)
    expect(content).toContain(`wire_api = "responses"`)
    expect(content).toContain(`preferred_auth_method = "apikey"`)
    expect(content.endsWith("\n")).toBe(true)
  })

  test("writes user-owned scalars outside the managed block", () => {
    const { content } = applyCodexConfig({
      baseUrl: BASE_URL,
      existingContent: "",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
    })
    const blockStart = content.indexOf(BEGIN_MARK)
    const modelIdx = content.indexOf(`model = "gpt-5.5"`)
    const effortIdx = content.indexOf(`model_reasoning_effort = "high"`)
    expect(modelIdx).toBeGreaterThanOrEqual(0)
    expect(effortIdx).toBeGreaterThanOrEqual(0)
    // User scalars live before the managed block, not inside it.
    expect(modelIdx).toBeLessThan(blockStart)
    expect(effortIdx).toBeLessThan(blockStart)
  })
})

describe("applyCodexConfig — idempotency & replacement", () => {
  test("re-applying identical input yields no change", () => {
    const first = applyCodexConfig({ baseUrl: BASE_URL, existingContent: "" })
    const second = applyCodexConfig({ baseUrl: BASE_URL, existingContent: first.content })
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
  })

  test("replaces an existing managed block in place (no duplicate)", () => {
    const first = applyCodexConfig({ baseUrl: BASE_URL, existingContent: "" })
    const updated = applyCodexConfig({ baseUrl: "http://localhost:9999/v1", existingContent: first.content })
    expect(updated.changed).toBe(true)
    // Exactly one managed block.
    expect(updated.content.split(BEGIN_MARK).length - 1).toBe(1)
    expect(updated.content).toContain(`base_url = "http://localhost:9999/v1"`)
    expect(updated.content).not.toContain(BASE_URL)
  })
})

describe("applyCodexConfig — preserves user content", () => {
  test("keeps comments and unrelated tables outside the block", () => {
    const userContent = ["# my codex notes", 'approval_policy = "on-request"', "", "[tui]", 'theme = "dark"', ""].join("\n")
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: userContent })
    expect(content).toContain("# my codex notes")
    expect(content).toContain(`approval_policy = "on-request"`)
    expect(content).toContain("[tui]")
    expect(content).toContain(`theme = "dark"`)
    expect(content).toContain(BEGIN_MARK)
  })

  test("user content survives a strip+re-apply round trip verbatim", () => {
    const userContent = ["# header comment", "[tui]", 'theme = "dark"'].join("\n")
    const first = applyCodexConfig({ baseUrl: BASE_URL, existingContent: userContent })
    const second = applyCodexConfig({ baseUrl: BASE_URL, existingContent: first.content })
    expect(second.changed).toBe(false)
    expect(second.content).toContain("# header comment")
    expect(second.content).toContain(`theme = "dark"`)
  })
})

describe("applyCodexConfig — duplicate-key guard", () => {
  test("does not add model when user already declares it", () => {
    const existing = `model = "my-existing-model"\n`
    const { content } = applyCodexConfig({
      baseUrl: BASE_URL,
      existingContent: existing,
      model: "gpt-5.5",
    })
    // Only the user's declaration remains — no second `model =` line.
    expect(content.match(/^\s*model\s*=/gm)?.length).toBe(1)
    expect(content).toContain(`model = "my-existing-model"`)
    expect(content).not.toContain(`model = "gpt-5.5"`)
  })

  test("does not add model_reasoning_effort when user already declares it", () => {
    const existing = `model_reasoning_effort = "low"\n`
    const { content } = applyCodexConfig({
      baseUrl: BASE_URL,
      existingContent: existing,
      modelReasoningEffort: "high",
    })
    expect(content.match(/^\s*model_reasoning_effort\s*=/gm)?.length).toBe(1)
    expect(content).toContain(`model_reasoning_effort = "low"`)
  })

  test("omits user scalars entirely when caller passes none", () => {
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: "" })
    expect(content).not.toMatch(/^\s*model\s*=/m)
    expect(content).not.toMatch(/^\s*model_reasoning_effort\s*=/m)
  })

  test("strips a stray top-level model_provider so it is never duplicated (H1)", () => {
    // A user who hand-configured per the old README has a top-level model_provider.
    const existing = `model_provider = "openai"\n\n[model_providers.openai]\nname = "openai"\n`
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: existing })
    // Exactly one top-level model_provider (ours), no TOML duplicate key.
    expect(content.match(/^\s*model_provider\s*=/gm)?.length).toBe(1)
    expect(content).toContain(`model_provider = "ghc"`)
    // The user's own provider table is preserved.
    expect(content).toContain("[model_providers.openai]")
  })

  test("strips a stray out-of-block [model_providers.ghc] so Codex doesn't hit redefinition-of-table (H3)", () => {
    // A user who hand-configured per the OLD README wrote the SAME provider table
    // we manage. Without dedup, the output would contain two [model_providers.ghc]
    // headers → TOML `redefinition of table` → Codex config load fails entirely.
    const existing = [
      `model_provider = "ghc"`,
      "",
      "[model_providers.ghc]",
      `name = "ghc"`,
      `base_url = "http://localhost:4141/v1"`,
      `wire_api = "responses"`,
      "",
      "[model_providers.openai]",
      `name = "openai"`,
    ].join("\n")
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: existing })
    // Exactly ONE [model_providers.ghc] header (ours, inside the managed block).
    expect(content.match(/^\s*\[model_providers\.ghc\]\s*$/gm)?.length).toBe(1)
    // It lives inside the managed block.
    const blockStart = content.indexOf(">>> copilot-api managed block")
    const blockEnd = content.indexOf("<<< copilot-api managed block")
    const ghcIdx = content.indexOf("[model_providers.ghc]")
    expect(ghcIdx).toBeGreaterThan(blockStart)
    expect(ghcIdx).toBeLessThan(blockEnd)
    // Other providers' tables are preserved.
    expect(content).toContain("[model_providers.openai]")
    // Re-applying is idempotent (no second dup creeps in).
    const second = applyCodexConfig({ baseUrl: BASE_URL, existingContent: content })
    expect(second.changed).toBe(false)
  })

  test("preserves [model_providers.ghc.x] sub-tables and array-of-tables (only exact table removed)", () => {
    const existing = ["[model_providers.ghc.headers]", `x-foo = "bar"`, "", "[[some_array]]", `k = "v"`].join("\n")
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: existing })
    // Sub-table (different TOML entity) is NOT removed.
    expect(content).toContain("[model_providers.ghc.headers]")
    expect(content).toContain(`x-foo = "bar"`)
    // Array-of-tables preserved.
    expect(content).toContain("[[some_array]]")
  })

  test("does not reformat user blank lines elsewhere in the rest section (H3 seam-local)", () => {
    // 3 intentional blank lines between two unrelated tables must survive verbatim
    // (the dedup of a stray ghc table must not globally collapse blank runs).
    const existing = ["[a]", `x = 1`, "", "", "", "[b]", `y = 2`].join("\n")
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: existing })
    expect(content).toContain(["[a]", `x = 1`, "", "", "", "[b]", `y = 2`].join("\n"))
  })

  test("a table-scoped model key does not suppress the top-level default (M1)", () => {
    const existing = `[profiles.fast]\nmodel = "gpt-4"\n`
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: existing, model: "gpt-5.5" })
    // Top-level default is written despite the table-scoped `model =`.
    expect(content).toMatch(/^model = "gpt-5\.5"/m)
    // The table-scoped key is left untouched.
    expect(content).toContain(`[profiles.fast]\nmodel = "gpt-4"`)
  })

  test("escapes quotes/backslashes in scalar values", () => {
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: "", model: String.raw`weird"\name` })
    expect(content).toContain(String.raw`model = "weird\"\\name"`)
  })
})

describe("applyCodexConfig — legacy migration", () => {
  test("strips a legacy copilot-bridge managed block (no duplicate provider)", () => {
    const legacy = [
      "# >>> copilot-bridge managed block — auto-generated, do not edit between markers >>>",
      `model_provider = "ghc"`,
      "",
      "[model_providers.ghc]",
      `name = "ghc"`,
      `base_url = "http://old:1234/v1"`,
      `wire_api = "responses"`,
      "# <<< copilot-bridge managed block — edits outside this block are preserved <<<",
    ].join("\n")
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: legacy })
    expect(content).not.toContain("copilot-bridge")
    expect(content).not.toContain("http://old:1234/v1")
    // Exactly one (new) managed block.
    expect(content.split(BEGIN_MARK).length - 1).toBe(1)
    expect(content).toContain(`base_url = "${BASE_URL}"`)
  })

  test("strips the oldest legacy marker variant", () => {
    const legacy = ["# >>> copilot-bridge managed (do not edit) >>>", `model_provider = "ghc"`, "# <<< copilot-bridge managed (do not edit) <<<"].join("\n")
    const { content } = applyCodexConfig({ baseUrl: BASE_URL, existingContent: legacy })
    expect(content).not.toContain("do not edit) >>>")
    expect(content.split(BEGIN_MARK).length - 1).toBe(1)
  })
})

describe("atomicWriteText", () => {
  const tmpRoot = path.join(os.tmpdir(), `codex-config-test-${process.pid}-${Date.now()}`)

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  test("writes content atomically and overwrites existing", async () => {
    await fs.mkdir(tmpRoot, { recursive: true })
    const target = path.join(tmpRoot, "config.toml")
    await atomicWriteText(target, "first\n")
    expect(await fs.readFile(target, "utf8")).toBe("first\n")
    await atomicWriteText(target, "second\n")
    expect(await fs.readFile(target, "utf8")).toBe("second\n")
    // No stray temp files left behind.
    const leftover = (await fs.readdir(tmpRoot)).filter((f) => f.includes(".tmp."))
    expect(leftover).toHaveLength(0)
  })
})

/**
 * Unit tests for setup-claude-code.
 *
 * SAFETY: every test that touches the filesystem injects a per-test `mkdtemp`
 * temp directory via `options.home` and a deterministic `options.confirm`.
 * This is the ONLY isolation seam used — we never mock `node:os`, never touch
 * `process.env.HOME`, and never call `writeClaudeCodeConfig` without an explicit
 * temp `home`. As a result no test can ever write the real `~/.claude.json` or
 * `~/.claude/settings.json`.
 */

import {
  //
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import {
  //
  existsSync,
  promises as fsPromises,
} from "node:fs"
import * as nodeOs from "node:os"
import { join } from "node:path"

import { type Model } from "~/lib/models/client"
import {
  //
  buildClaudeCodeEnv,
  buildEssentialEnv,
  buildExtensionEnv,
  computeJsonDiff,
  decideWriteAction,
  formatJsonDiff,
  hasJsonDiff,
  withClaudeCode1mSuffix,
  writeClaudeCodeConfig,
} from "~/setup-claude-code"

/** Build a minimal Model fixture for tests. */
function makeModel(id: string, maxPromptTokens?: number): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    vendor: "test",
    version: "1",
    capabilities: maxPromptTokens === undefined ? undefined : { limits: { max_prompt_tokens: maxPromptTokens } },
  }
}

const SONNET = makeModel("claude-sonnet-4", 200_000)
const HAIKU = makeModel("claude-haiku-3.5", 200_000)
const OPUS_1M = makeModel("claude-opus-4.6", 1_000_000)

const URL = "http://localhost:4141"

// ============================================================================
// Filesystem-test harness — temp home + deterministic confirm
// ============================================================================

/** Active temp homes created during the suite, cleaned up in afterEach. */
const tempHomes: Array<string> = []

/** Create a fresh temp dir to use as `options.home`. Registered for cleanup. */
async function makeTempHome(): Promise<string> {
  const dir = await fsPromises.mkdtemp(join(nodeOs.tmpdir(), "claude-code-test-"))
  tempHomes.push(dir)
  return dir
}

/** Always-reject confirm — proposed changes are aborted. */
const reject = (): Promise<boolean> => Promise.resolve(false)

// Safety net against the past incident (a test wrote the user's REAL ~/.claude):
// `writeClaudeCodeConfig` falls back to `os.homedir()` when no `home` is passed.
// Spy homedir to THROW for the whole suite so any future test that forgets to
// inject a temp `home` fails loudly instead of clobbering real config. Every
// test here passes a temp `home`, so homedir() is never legitimately reached.
let homedirSpy: ReturnType<typeof spyOn>
beforeAll(() => {
  homedirSpy = spyOn(nodeOs, "homedir").mockImplementation(() => {
    throw new Error("os.homedir() reached — a writeClaudeCodeConfig call is missing its temp `home`")
  })
})
afterAll(() => {
  homedirSpy.mockRestore()
})

afterEach(async () => {
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop()
    if (dir && existsSync(dir)) await fsPromises.rm(dir, { recursive: true })
  }
})

/** Read+parse a JSON file written under a temp home. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsPromises.readFile(path, "utf8")) as Record<string, unknown>
}

/** Read the `env` block from a settings.json under `home`. */
async function readEnv(home: string): Promise<Record<string, string>> {
  const settings = await readJson(join(home, ".claude", "settings.json"))
  return settings.env as Record<string, string>
}

// ============================================================================
// withClaudeCode1mSuffix
// ============================================================================

describe("withClaudeCode1mSuffix", () => {
  test("returns id unchanged when maxPromptTokens is undefined", () => {
    expect(withClaudeCode1mSuffix("claude-sonnet-4", undefined)).toBe("claude-sonnet-4")
  })

  test("returns id unchanged when maxPromptTokens is zero (treated as unknown)", () => {
    expect(withClaudeCode1mSuffix("claude-sonnet-4", 0)).toBe("claude-sonnet-4")
  })

  test("returns id unchanged when below or at the 1M band floor", () => {
    expect(withClaudeCode1mSuffix("claude-sonnet-4", 200_000)).toBe("claude-sonnet-4")
    expect(withClaudeCode1mSuffix("claude-sonnet-4", 800_000)).toBe("claude-sonnet-4")
  })

  test("appends [1m] suffix when in the 1M band", () => {
    expect(withClaudeCode1mSuffix("claude-opus-4.6", 1_000_000)).toBe("claude-opus-4.6[1m]")
    expect(withClaudeCode1mSuffix("claude-opus-4.6", 900_000)).toBe("claude-opus-4.6[1m]")
  })

  test("returns id unchanged at or above the 1M band ceiling (2M+ tier)", () => {
    expect(withClaudeCode1mSuffix("future-model", 1_500_000)).toBe("future-model")
    expect(withClaudeCode1mSuffix("future-model", 2_000_000)).toBe("future-model")
  })

  test("is idempotent when id already carries the suffix", () => {
    expect(withClaudeCode1mSuffix("claude-opus-4.6[1m]", 1_000_000)).toBe("claude-opus-4.6[1m]")
  })
})

// ============================================================================
// buildEssentialEnv
// ============================================================================

describe("buildEssentialEnv", () => {
  test("contains exactly the five essential keys and nothing else", () => {
    const env = buildEssentialEnv(URL, SONNET, HAIKU)
    expect(Object.keys(env).sort()).toEqual(
      ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_MODEL"].sort(),
    )
  })

  test("maps base url and model ids", () => {
    const env = buildEssentialEnv(URL, SONNET, HAIKU)
    expect(env.ANTHROPIC_BASE_URL).toBe(URL)
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-3.5")
  })

  test("falls back to copilot-api token when none provided", () => {
    expect(buildEssentialEnv(URL, SONNET, HAIKU).ANTHROPIC_AUTH_TOKEN).toBe("copilot-api")
  })

  test("preserves user-customized ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildEssentialEnv(URL, SONNET, HAIKU, { ANTHROPIC_AUTH_TOKEN: "sk-real-key" })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-real-key")
  })

  test("applies [1m] suffix to main and small model ids independently", () => {
    const env = buildEssentialEnv(URL, OPUS_1M, OPUS_1M)
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-opus-4.6[1m]")
  })

  test("does not include extension keys", () => {
    const env = buildEssentialEnv(URL, SONNET, HAIKU)
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBeUndefined()
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
  })
})

// ============================================================================
// buildExtensionEnv
// ============================================================================

describe("buildExtensionEnv", () => {
  test("sets the opinionated extension keys", () => {
    const env = buildExtensionEnv(SONNET)
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0")
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0")
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85")
  })

  test("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from the model's max_prompt_tokens", () => {
    expect(buildExtensionEnv(OPUS_1M).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
  })

  test("omits CLAUDE_CODE_AUTO_COMPACT_WINDOW when the model has no limit", () => {
    expect(buildExtensionEnv(makeModel("unknown")).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
  })

  test("preserves user-customized CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", () => {
    const env = buildExtensionEnv(SONNET, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" })
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("70")
  })

  test("does not include essential keys", () => {
    const env = buildExtensionEnv(SONNET)
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
  })
})

// ============================================================================
// buildClaudeCodeEnv
// ============================================================================

describe("buildClaudeCodeEnv", () => {
  test("by default writes essential keys but no extension keys", () => {
    const env = buildClaudeCodeEnv(URL, SONNET, HAIKU)
    expect(env.ANTHROPIC_BASE_URL).toBe(URL)
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4")
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBeUndefined()
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
  })

  test("includes extension keys only when includeExtensions is set", () => {
    const env = buildClaudeCodeEnv(URL, SONNET, HAIKU, {}, { includeExtensions: true })
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0")
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000")
  })

  test("carries over unrelated existing keys untouched", () => {
    const env = buildClaudeCodeEnv(URL, SONNET, HAIKU, { CUSTOM_VAR: "keep-me" })
    expect(env.CUSTOM_VAR).toBe("keep-me")
  })

  test("preserves existing extension keys even when includeExtensions is false", () => {
    const env = buildClaudeCodeEnv(URL, SONNET, HAIKU, { CLAUDE_CODE_ENABLE_TELEMETRY: "1" })
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1")
  })

  test("strips deprecated ANTHROPIC_SMALL_FAST_MODEL from carry-over", () => {
    const env = buildClaudeCodeEnv(URL, SONNET, HAIKU, {
      ANTHROPIC_SMALL_FAST_MODEL: "old-haiku",
      CUSTOM_VAR: "keep-me",
    })
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    expect(env.CUSTOM_VAR).toBe("keep-me")
  })

  test("never emits ANTHROPIC_SMALL_FAST_MODEL even on a blank slate", () => {
    expect(buildClaudeCodeEnv(URL, SONNET, HAIKU).ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
  })

  test("preserves user-customized ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildClaudeCodeEnv(URL, SONNET, HAIKU, { ANTHROPIC_AUTH_TOKEN: "sk-my-real-key" })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-my-real-key")
  })

  test("applies [1m] suffix to main and small model ids", () => {
    const env = buildClaudeCodeEnv(URL, OPUS_1M, SONNET)
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4")
  })
})

// ============================================================================
// computeJsonDiff / hasJsonDiff / formatJsonDiff
// ============================================================================

describe("computeJsonDiff", () => {
  test("classifies added, changed, and removed top-level leaves", () => {
    const before = { KEEP: "1", CHANGE: "old", DROP: "x" }
    const after = { KEEP: "1", CHANGE: "new", ADD: "y" }
    const diff = computeJsonDiff(before, after)
    expect(diff.added).toEqual([{ path: "ADD", after: "y" }])
    expect(diff.changed).toEqual([{ path: "CHANGE", before: "old", after: "new" }])
    expect(diff.removed).toEqual([{ path: "DROP", before: "x" }])
  })

  test("walks into nested objects and reports dotted leaf paths", () => {
    const before = { env: { A: "1", B: "old" }, top: "same" }
    const after = { env: { A: "1", B: "new", C: "2" }, top: "same" }
    const diff = computeJsonDiff(before, after)
    expect(diff.added).toEqual([{ path: "env.C", after: "2" }])
    expect(diff.changed).toEqual([{ path: "env.B", before: "old", after: "new" }])
    expect(diff.removed).toEqual([])
  })

  test("treats a pruned nested key as a removal at its leaf path", () => {
    const diff = computeJsonDiff({ env: { A: "1", GONE: "x" } }, { env: { A: "1" } })
    expect(diff.removed).toEqual([{ path: "env.GONE", before: "x" }])
  })

  test("compares arrays as whole leaves (order-sensitive)", () => {
    const same = computeJsonDiff({ a: [1, 2] }, { a: [1, 2] })
    expect(hasJsonDiff(same)).toBe(false)
    const reordered = computeJsonDiff({ a: [1, 2] }, { a: [2, 1] })
    expect(reordered.changed).toEqual([{ path: "a", before: [1, 2], after: [2, 1] }])
  })

  test("a brand-new object is all additions", () => {
    const diff = computeJsonDiff({}, { env: { A: "1" }, hasCompletedOnboarding: true })
    expect(diff.added).toEqual([
      { path: "env.A", after: "1" },
      { path: "hasCompletedOnboarding", after: true },
    ])
    expect(diff.changed).toEqual([])
    expect(diff.removed).toEqual([])
  })

  test("hasJsonDiff is false when nothing differs", () => {
    const same = { a: "1", b: { c: "2" } }
    expect(hasJsonDiff(computeJsonDiff(same, { a: "1", b: { c: "2" } }))).toBe(false)
  })
})

describe("formatJsonDiff", () => {
  test("renders +, ~ and - lines with compact JSON values", () => {
    const diff = computeJsonDiff({ CHANGE: "old", DROP: "x" }, { CHANGE: "new", ADD: "y" })
    const text = formatJsonDiff(diff)
    expect(text).toContain(`  + ADD: "y"`)
    expect(text).toContain(`  ~ CHANGE: "old" → "new"`)
    expect(text).toContain(`  - DROP: "x"`)
  })

  test("truncates over-long values", () => {
    const long = "z".repeat(200)
    const text = formatJsonDiff(computeJsonDiff({}, { k: long }))
    expect(text).toContain("...")
    expect(text.length).toBeLessThan(long.length)
  })

  test("renders an empty string when there are no changes", () => {
    expect(formatJsonDiff({ added: [], changed: [], removed: [] })).toBe("")
  })
})

// ============================================================================
// decideWriteAction (pure)
// ============================================================================

describe("decideWriteAction", () => {
  test("no changes -> skip regardless of other flags", () => {
    expect(decideWriteAction({ hasChanges: false, dryRun: false, yes: true, isTTY: true })).toBe("skip-no-changes")
    expect(decideWriteAction({ hasChanges: false, dryRun: true, yes: false, isTTY: false })).toBe("skip-no-changes")
  })

  test("dry-run wins over --yes and TTY", () => {
    expect(decideWriteAction({ hasChanges: true, dryRun: true, yes: true, isTTY: true })).toBe("dry-run")
  })

  test("--yes auto-applies", () => {
    expect(decideWriteAction({ hasChanges: true, dryRun: false, yes: true, isTTY: false })).toBe("apply")
  })

  test("non-interactive without --yes aborts", () => {
    expect(decideWriteAction({ hasChanges: true, dryRun: false, yes: false, isTTY: false })).toBe("abort-non-interactive")
  })

  test("interactive without --yes prompts", () => {
    expect(decideWriteAction({ hasChanges: true, dryRun: false, yes: false, isTTY: true })).toBe("prompt")
  })
})

// ============================================================================
// writeClaudeCodeConfig — always with temp home + injected confirm
// ============================================================================

describe("writeClaudeCodeConfig", () => {
  test("without a temp home, the homedir guard blocks it before any real write", async () => {
    // Proves the safety net: omitting `home` makes the src fall back to
    // os.homedir() (spied to throw), so it rejects on the very first line —
    // before reading/writing any file — and can never touch the real ~/.claude.
    await expect(writeClaudeCodeConfig(URL, SONNET, HAIKU)).rejects.toThrow(/missing its temp `home`/u)
  })

  test("on a blank slate writes essential env and onboarding=true (no extensions)", async () => {
    const home = await makeTempHome()
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true })

    const claudeJson = await readJson(join(home, ".claude.json"))
    expect(claudeJson.hasCompletedOnboarding).toBe(true)

    const env = await readEnv(home)
    expect(env.ANTHROPIC_BASE_URL).toBe(URL)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("copilot-api")
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-3.5")
    // Extensions are opt-in — must NOT appear by default.
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBeUndefined()
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
  })

  test("creates the .claude directory when missing", async () => {
    const home = await makeTempHome()
    expect(existsSync(join(home, ".claude"))).toBe(false)
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true })
    expect(existsSync(join(home, ".claude"))).toBe(true)
  })

  test("includeExtensions writes the opinionated extension keys", async () => {
    const home = await makeTempHome()
    await writeClaudeCodeConfig(URL, OPUS_1M, HAIKU, { home, includeExtensions: true, yes: true })

    const env = await readEnv(home)
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0")
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0")
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85")
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
  })

  test("merges existing .claude.json without losing data", async () => {
    const home = await makeTempHome()
    const claudeJsonPath = join(home, ".claude.json")
    await fsPromises.writeFile(claudeJsonPath, JSON.stringify({ existingKey: "value", someArray: [1, 2, 3] }, null, 2) + "\n")

    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true })

    const content = await readJson(claudeJsonPath)
    expect(content.existingKey).toBe("value")
    expect(content.someArray).toEqual([1, 2, 3])
    expect(content.hasCompletedOnboarding).toBe(true)
  })

  test("preserves unrelated settings keys and user env, overwrites essential, drops deprecated", async () => {
    const home = await makeTempHome()
    const claudeDir = join(home, ".claude")
    await fsPromises.mkdir(claudeDir, { recursive: true })
    await fsPromises.writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: ["Read", "Write"] },
          env: {
            CUSTOM_VAR: "keep-me",
            ANTHROPIC_AUTH_TOKEN: "sk-user-real-key",
            ANTHROPIC_BASE_URL: "http://old-server:8080",
            ANTHROPIC_SMALL_FAST_MODEL: "old-haiku",
          },
        },
        null,
        2,
      ) + "\n",
    )

    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true })

    const settings = await readJson(join(claudeDir, "settings.json"))
    const env = settings.env as Record<string, string>
    expect(env.CUSTOM_VAR).toBe("keep-me")
    // Existing user auth token is preserved (not clobbered with placeholder).
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-user-real-key")
    expect(env.ANTHROPIC_BASE_URL).toBe(URL)
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    expect(settings.permissions).toEqual({ allow: ["Read", "Write"] })
  })

  test("interactive: rejecting the prompt writes nothing (every file, even pure additions)", async () => {
    const home = await makeTempHome()
    // Blank slate — both files are pure additions. Design mandates a confirm
    // even for additions, and default No aborts.
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, isTTY: true, confirm: reject })

    expect(existsSync(join(home, ".claude.json"))).toBe(false)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false)
  })

  test("interactive: approving the prompt writes both files", async () => {
    const home = await makeTempHome()
    let confirmCalls = 0
    const countingApprove = (): Promise<boolean> => {
      confirmCalls += 1
      return Promise.resolve(true)
    }
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, isTTY: true, confirm: countingApprove })

    // One confirm per target file (each file is confirmed independently).
    expect(confirmCalls).toBe(2)
    expect(existsSync(join(home, ".claude.json"))).toBe(true)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true)
  })

  test("per-file confirm: rejecting one file still applies the other", async () => {
    const home = await makeTempHome()
    // Reject the first target (.claude.json), approve the second (settings.json).
    let call = 0
    const confirm = (message: string): Promise<boolean> => {
      call += 1
      return Promise.resolve(message.includes("settings.json"))
    }
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, isTTY: true, confirm })

    expect(call).toBe(2)
    // .claude.json skipped, settings.json written.
    expect(existsSync(join(home, ".claude.json"))).toBe(false)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true)
  })

  test("--yes auto-applies without prompting", async () => {
    const home = await makeTempHome()
    let confirmCalls = 0
    const countingConfirm = (): Promise<boolean> => {
      confirmCalls += 1
      return Promise.resolve(true)
    }
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true, isTTY: true, confirm: countingConfirm })

    expect(confirmCalls).toBe(0)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true)
  })

  test("non-interactive without --yes aborts (never clobbers)", async () => {
    const home = await makeTempHome()
    const claudeDir = join(home, ".claude")
    await fsPromises.mkdir(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, "settings.json")
    const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://old-server:8080" } }, null, 2) + "\n"
    await fsPromises.writeFile(settingsPath, original)

    // isTTY false + no yes -> abort every file.
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, isTTY: false })

    expect(await fsPromises.readFile(settingsPath, "utf8")).toBe(original)
    expect(existsSync(join(home, ".claude.json"))).toBe(false)
  })

  test("--dry-run shows diffs but writes nothing, even with --yes", async () => {
    const home = await makeTempHome()
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true, dryRun: true })

    expect(existsSync(join(home, ".claude.json"))).toBe(false)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false)
  })

  test("refuses to overwrite a malformed existing file (never swallows parse failure)", async () => {
    const home = await makeTempHome()
    const claudeDir = join(home, ".claude")
    await fsPromises.mkdir(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, "settings.json")
    const garbage = "{ this is not valid json "
    await fsPromises.writeFile(settingsPath, garbage)

    // --yes would otherwise write; the parse guard must still refuse settings.json.
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true })

    // Malformed file left untouched (not clobbered).
    expect(await fsPromises.readFile(settingsPath, "utf8")).toBe(garbage)
    // The other, well-formed target still gets written independently.
    expect(existsSync(join(home, ".claude.json"))).toBe(true)
  })

  test("is a no-op when already fully configured", async () => {
    const home = await makeTempHome()
    // First run establishes the configured state.
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, { home, yes: true })

    const settingsPath = join(home, ".claude", "settings.json")
    const claudeJsonPath = join(home, ".claude.json")
    const settingsBefore = await fsPromises.readFile(settingsPath, "utf8")
    const claudeJsonBefore = await fsPromises.readFile(claudeJsonPath, "utf8")

    // Second identical run: no changes -> skip both files, no prompt.
    let confirmCalls = 0
    await writeClaudeCodeConfig(URL, SONNET, HAIKU, {
      home,
      isTTY: true,
      confirm: () => {
        confirmCalls += 1
        return Promise.resolve(true)
      },
    })

    expect(confirmCalls).toBe(0)
    expect(await fsPromises.readFile(settingsPath, "utf8")).toBe(settingsBefore)
    expect(await fsPromises.readFile(claudeJsonPath, "utf8")).toBe(claudeJsonBefore)
  })

  test("uses the provided server URL and applies [1m] suffix when applicable", async () => {
    const home = await makeTempHome()
    await writeClaudeCodeConfig("http://192.168.1.100:8080", OPUS_1M, SONNET, { home, yes: true })

    const env = await readEnv(home)
    expect(env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.100:8080")
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4")
  })
})

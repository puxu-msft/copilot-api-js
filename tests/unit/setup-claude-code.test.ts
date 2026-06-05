/**
 * Unit tests for setup-claude-code: writeClaudeCodeConfig, buildClaudeCodeEnv,
 * and withClaudeCode1mSuffix.
 *
 * Tests the real functions by mocking homedir() to a temporary directory,
 * so we verify actual file I/O and merge logic.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import {
  //
  existsSync,
  promises as fsPromises,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Model } from "~/lib/models/client"

// ─── Mock homedir() to a per-test temp directory ───

let testHome: string

mock.module("node:os", () => ({
  homedir: () => testHome,
  tmpdir,
}))

const { writeClaudeCodeConfig, buildClaudeCodeEnv, withClaudeCode1mSuffix } = await import("~/setup-claude-code")

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

describe("withClaudeCode1mSuffix", () => {
  test("returns id unchanged when maxPromptTokens is undefined", () => {
    expect(withClaudeCode1mSuffix("claude-sonnet-4", undefined)).toBe("claude-sonnet-4")
  })

  test("returns id unchanged when maxPromptTokens is zero (treated as unknown)", () => {
    expect(withClaudeCode1mSuffix("claude-sonnet-4", 0)).toBe("claude-sonnet-4")
  })

  test("returns id unchanged when below the 1M band", () => {
    expect(withClaudeCode1mSuffix("claude-sonnet-4", 200_000)).toBe("claude-sonnet-4")
    expect(withClaudeCode1mSuffix("claude-sonnet-4", 800_000)).toBe("claude-sonnet-4")
  })

  test("appends [1m] suffix when in the 1M band", () => {
    expect(withClaudeCode1mSuffix("claude-opus-4.6", 1_000_000)).toBe("claude-opus-4.6[1m]")
    expect(withClaudeCode1mSuffix("claude-opus-4.6", 900_000)).toBe("claude-opus-4.6[1m]")
  })

  test("returns id unchanged when at or above the 1M band ceiling (2M+ tier)", () => {
    expect(withClaudeCode1mSuffix("future-model", 1_500_000)).toBe("future-model")
    expect(withClaudeCode1mSuffix("future-model", 2_000_000)).toBe("future-model")
  })

  test("is idempotent when id already carries the suffix", () => {
    expect(withClaudeCode1mSuffix("claude-opus-4.6[1m]", 1_000_000)).toBe("claude-opus-4.6[1m]")
  })
})

describe("buildClaudeCodeEnv", () => {
  test("sets attribution header to 0 (prompt-cache fix)", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU)
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0")
  })

  test("omits deprecated ANTHROPIC_SMALL_FAST_MODEL", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU)
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
  })

  test("strips deprecated ANTHROPIC_SMALL_FAST_MODEL from carry-over env", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU, {
      ANTHROPIC_SMALL_FAST_MODEL: "old-haiku",
      CUSTOM_VAR: "keep-me",
    })
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    expect(env.CUSTOM_VAR).toBe("keep-me")
  })

  test("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from main model's max_prompt_tokens", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", OPUS_1M, HAIKU)
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
  })

  test("omits CLAUDE_CODE_AUTO_COMPACT_WINDOW when main model has no limit", () => {
    const noLimit = makeModel("unknown-model")
    const env = buildClaudeCodeEnv("http://localhost:4141", noLimit, HAIKU)
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
  })

  test("defaults CLAUDE_AUTOCOMPACT_PCT_OVERRIDE to 85 when not set", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU)
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85")
  })

  test("preserves user-customized CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU, {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70",
    })
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("70")
  })

  test("preserves user-customized ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU, {
      ANTHROPIC_AUTH_TOKEN: "sk-my-real-key",
    })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-my-real-key")
  })

  test("falls back to copilot-api token when no user token set", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, HAIKU)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("copilot-api")
  })

  test("applies [1m] suffix to main model id when in 1M band", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", OPUS_1M, HAIKU)
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-opus-4.6[1m]")
  })

  test("applies [1m] suffix to small model id independently", () => {
    const env = buildClaudeCodeEnv("http://localhost:4141", SONNET, OPUS_1M)
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-opus-4.6[1m]")
  })
})

describe("writeClaudeCodeConfig", () => {
  beforeEach(async () => {
    testHome = await fsPromises.mkdtemp(join(tmpdir(), "claude-code-test-"))
  })

  afterEach(async () => {
    if (testHome && existsSync(testHome)) {
      await fsPromises.rm(testHome, { recursive: true })
    }
  })

  test("creates .claude.json with hasCompletedOnboarding", async () => {
    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    const claudeJsonPath = join(testHome, ".claude.json")
    expect(existsSync(claudeJsonPath)).toBe(true)

    const content = JSON.parse(await fsPromises.readFile(claudeJsonPath, "utf8")) as Record<string, unknown>
    expect(content.hasCompletedOnboarding).toBe(true)
  })

  test("creates .claude/settings.json with correct env variables", async () => {
    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    const settingsPath = join(testHome, ".claude", "settings.json")
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4141")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("copilot-api")
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-3.5")
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0")
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0")
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85")
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000")
  })

  test("merges with existing .claude.json without losing data", async () => {
    // Pre-create .claude.json with existing data
    const claudeJsonPath = join(testHome, ".claude.json")
    await fsPromises.writeFile(
      claudeJsonPath,
      JSON.stringify({ existingKey: "value", someArray: [1, 2, 3] }, null, 2) + "\n",
    )

    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    const content = JSON.parse(await fsPromises.readFile(claudeJsonPath, "utf8")) as Record<string, unknown>
    expect(content.existingKey).toBe("value")
    expect(content.someArray).toEqual([1, 2, 3])
    expect(content.hasCompletedOnboarding).toBe(true)
  })

  test("merges env with existing settings.json without losing other keys", async () => {
    // Pre-create settings.json with existing data
    const claudeDir = join(testHome, ".claude")
    await fsPromises.mkdir(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, "settings.json")
    await fsPromises.writeFile(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Read", "Write"] },
          env: { CUSTOM_VAR: "keep-me", ANTHROPIC_BASE_URL: "http://old-server:8080" },
        },
        null,
        2,
      ) + "\n",
    )

    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    // Existing custom var preserved
    expect(env.CUSTOM_VAR).toBe("keep-me")
    // Old URL overwritten
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4141")
    // Other settings keys preserved
    expect(settings.permissions).toEqual({ allow: ["Read", "Write"] })
  })

  test("preserves existing ANTHROPIC_AUTH_TOKEN from settings.json", async () => {
    const claudeDir = join(testHome, ".claude")
    await fsPromises.mkdir(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, "settings.json")
    await fsPromises.writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-user-real-key" } }, null, 2) + "\n",
    )

    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-user-real-key")
  })

  test("removes deprecated ANTHROPIC_SMALL_FAST_MODEL from existing settings.json", async () => {
    const claudeDir = join(testHome, ".claude")
    await fsPromises.mkdir(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, "settings.json")
    await fsPromises.writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_SMALL_FAST_MODEL: "old-haiku" } }, null, 2) + "\n",
    )

    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
  })

  test("creates .claude directory if it does not exist", async () => {
    const claudeDir = join(testHome, ".claude")
    expect(existsSync(claudeDir)).toBe(false)

    await writeClaudeCodeConfig("http://localhost:4141", SONNET, HAIKU)

    expect(existsSync(claudeDir)).toBe(true)
  })

  test("uses provided server URL and model names with [1m] suffix when applicable", async () => {
    await writeClaudeCodeConfig("http://192.168.1.100:8080", OPUS_1M, SONNET)

    const settingsPath = join(testHome, ".claude", "settings.json")
    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.100:8080")
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6[1m]")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4")
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
  })
})

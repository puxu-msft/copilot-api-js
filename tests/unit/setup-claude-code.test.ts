/**
 * Unit tests for writeClaudeCodeConfig
 *
 * Tests the real function by mocking homedir() to a temporary directory,
 * so we verify actual file I/O and merge logic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, promises as fsPromises } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── Mock homedir() to a per-test temp directory ───

let testHome: string

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is synchronous in Bun test runtime
mock.module("node:os", () => ({
  homedir: () => testHome,
  tmpdir,
}))

const { writeClaudeCodeConfig } = await import("~/setup-claude-code")

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
    await writeClaudeCodeConfig("http://localhost:4141", "claude-sonnet-4", "claude-haiku-3.5")

    const claudeJsonPath = join(testHome, ".claude.json")
    expect(existsSync(claudeJsonPath)).toBe(true)

    const content = JSON.parse(await fsPromises.readFile(claudeJsonPath, "utf8")) as Record<string, unknown>
    expect(content.hasCompletedOnboarding).toBe(true)
  })

  test("creates .claude/settings.json with correct env variables", async () => {
    await writeClaudeCodeConfig("http://localhost:4141", "claude-sonnet-4", "claude-haiku-3.5")

    const settingsPath = join(testHome, ".claude", "settings.json")
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4141")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("copilot-api")
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4")
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-haiku-3.5")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-3.5")
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0")
  })

  test("merges with existing .claude.json without losing data", async () => {
    // Pre-create .claude.json with existing data
    const claudeJsonPath = join(testHome, ".claude.json")
    await fsPromises.writeFile(
      claudeJsonPath,
      JSON.stringify({ existingKey: "value", someArray: [1, 2, 3] }, null, 2) + "\n",
    )

    await writeClaudeCodeConfig("http://localhost:4141", "claude-sonnet-4", "claude-haiku-3.5")

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

    await writeClaudeCodeConfig("http://localhost:4141", "claude-sonnet-4", "claude-haiku-3.5")

    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    // Existing custom var preserved
    expect(env.CUSTOM_VAR).toBe("keep-me")
    // Old URL overwritten
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4141")
    // Other settings keys preserved
    expect(settings.permissions).toEqual({ allow: ["Read", "Write"] })
  })

  test("creates .claude directory if it does not exist", async () => {
    const claudeDir = join(testHome, ".claude")
    expect(existsSync(claudeDir)).toBe(false)

    await writeClaudeCodeConfig("http://localhost:4141", "claude-sonnet-4", "claude-haiku-3.5")

    expect(existsSync(claudeDir)).toBe(true)
  })

  test("uses provided server URL and model names", async () => {
    await writeClaudeCodeConfig("http://192.168.1.100:8080", "claude-opus-4.6", "claude-sonnet-4")

    const settingsPath = join(testHome, ".claude", "settings.json")
    const settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.100:8080")
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6")
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-4")
  })
})

/**
 * Unit tests for the Codex setup file-write orchestration (`writeCodexConfig`).
 *
 * SAFETY: every test injects an explicit `configPath` under a per-test `mkdtemp`
 * directory — `writeCodexConfig` never reads global path state, so it can never
 * touch the real `~/.codex/config.toml`. The pure TOML-assembly logic
 * (`applyCodexConfig`) is covered separately in `tests/config/codex-config.unit.test.ts`;
 * these tests exercise the read → apply → atomic-write I/O wrapper.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import { existsSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as nodeOs from "node:os"
import { join } from "node:path"

import { writeCodexConfig } from "~/setup-codex"

const BASE_URL = "http://localhost:4141/v1"

const tempDirs: Array<string> = []

async function makeTempConfigPath(): Promise<string> {
  const dir = await fsPromises.mkdtemp(join(nodeOs.tmpdir(), "codex-setup-test-"))
  tempDirs.push(dir)
  // Nest under a missing subdir to also exercise the mkdir-recursive path.
  return join(dir, ".codex", "config.toml")
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

describe("writeCodexConfig", () => {
  test("creates config.toml (and parent dir) on a blank slate", async () => {
    const configPath = await makeTempConfigPath()
    expect(existsSync(configPath)).toBe(false)

    const result = await writeCodexConfig({ configPath, baseUrl: BASE_URL, model: "claude-opus-4.8" })

    expect(result.changed).toBe(true)
    expect(existsSync(configPath)).toBe(true)
    const onDisk = await fsPromises.readFile(configPath, "utf8")
    expect(onDisk).toBe(result.content)
    // Managed block + provider wiring + user-owned model scalar present.
    expect(onDisk).toContain("copilot-api managed block")
    expect(onDisk).toContain("[model_providers.ghc]")
    expect(onDisk).toContain(`base_url = "${BASE_URL}"`)
    expect(onDisk).toContain(`model = "claude-opus-4.8"`)
  })

  test("is idempotent: re-applying identical input does not rewrite (changed=false)", async () => {
    const configPath = await makeTempConfigPath()
    const first = await writeCodexConfig({ configPath, baseUrl: BASE_URL, model: "claude-opus-4.8" })
    expect(first.changed).toBe(true)

    const mtime1 = (await fsPromises.stat(configPath)).mtimeMs
    const second = await writeCodexConfig({ configPath, baseUrl: BASE_URL, model: "claude-opus-4.8" })

    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
    // No write happened → mtime unchanged.
    expect((await fsPromises.stat(configPath)).mtimeMs).toBe(mtime1)
  })

  test("preserves unrelated user content outside the managed block on update", async () => {
    const configPath = await makeTempConfigPath()
    await fsPromises.mkdir(join(configPath, ".."), { recursive: true })
    const userContent = ["# my notes", `model = "gpt-4"`, "", "[profiles.fast]", `approval = "never"`].join("\n")
    await fsPromises.writeFile(configPath, userContent)

    const result = await writeCodexConfig({ configPath, baseUrl: BASE_URL, model: "claude-opus-4.8" })

    expect(result.changed).toBe(true)
    const onDisk = await fsPromises.readFile(configPath, "utf8")
    // User's comment, table and table-scoped key survive.
    expect(onDisk).toContain("# my notes")
    expect(onDisk).toContain("[profiles.fast]")
    expect(onDisk).toContain(`approval = "never"`)
    // The user's own top-level model wins → ours is not added.
    expect(onDisk.match(/^model = /gm)?.length).toBe(1)
    expect(onDisk).toContain(`model = "gpt-4"`)
  })

  test("removes a stray out-of-block [model_providers.ghc] (no TOML redefinition) on update", async () => {
    const configPath = await makeTempConfigPath()
    await fsPromises.mkdir(join(configPath, ".."), { recursive: true })
    // A user who hand-configured per the OLD README wrote the same provider table.
    const userContent = [`model_provider = "ghc"`, "", "[model_providers.ghc]", `name = "ghc"`, `base_url = "http://old/v1"`].join("\n")
    await fsPromises.writeFile(configPath, userContent)

    await writeCodexConfig({ configPath, baseUrl: BASE_URL, model: "claude-opus-4.8" })

    const onDisk = await fsPromises.readFile(configPath, "utf8")
    // Exactly one [model_providers.ghc] header (ours, inside the managed block).
    expect(onDisk.match(/^\s*\[model_providers\.ghc\]\s*$/gm)?.length).toBe(1)
    expect(onDisk).toContain(`base_url = "${BASE_URL}"`)
    expect(onDisk).not.toContain("http://old/v1")
  })

  test("writes the reasoning-effort scalar when supplied", async () => {
    const configPath = await makeTempConfigPath()
    await writeCodexConfig({ configPath, baseUrl: BASE_URL, model: "claude-opus-4.8", modelReasoningEffort: "high" })
    const onDisk = await fsPromises.readFile(configPath, "utf8")
    expect(onDisk).toContain(`model_reasoning_effort = "high"`)
  })
})

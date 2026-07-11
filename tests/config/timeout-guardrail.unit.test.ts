/**
 * Guardrail: warn when an upstream silence-guard timeout is explicitly disabled (0).
 *
 * Motivation (empirical, exp/ttfb-timeout-queued/report.md): with
 * `timeouts.response_header: 0` the TTFB abort signal is `undefined`, so a
 * silently hung GHC upstream keeps a single streaming request pending for
 * MINUTES until the upstream itself 502s (observed 691s). The mechanism is not
 * buggy — disabling the guard is the footgun. This warning makes the disabled
 * state visible at startup / on change, without spamming per-request hot-reload.
 *
 * `stream_idle: 0` is the same footgun class (mid-stream silence unbounded), so
 * it is covered by the same guardrail (learn-by-analogy).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

async function writeConfig(content: string): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeout-guardrail-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
})

afterEach(async () => {
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

function warnLines(spy: ReturnType<typeof spyOn<typeof consola, "warn">>): Array<string> {
  return spy.mock.calls.map((c) => c.map(String).join(" "))
}

describe("upstream silence-guard timeout disable warning", () => {
  test("response_header: 0 emits a prominent warning at first apply", async () => {
    await writeConfig("timeouts:\n  response_header: 0\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      const warned = warnLines(spy)
      expect(warned.some((l) => /response_header/.test(l) && /disabled/i.test(l))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("stream_idle: 0 also warns (same footgun class)", async () => {
    await writeConfig("timeouts:\n  stream_idle: 0\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((l) => /stream_idle/.test(l) && /disabled/i.test(l))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("both disabled → one warning naming both", async () => {
    await writeConfig("timeouts:\n  response_header: 0\n  stream_idle: 0\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      const combined = warnLines(spy).filter((l) => /disabled/i.test(l))
      expect(combined.some((l) => /response_header/.test(l) && /stream_idle/.test(l))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("positive timeouts (defaults) → NO warning", async () => {
    await writeConfig("timeouts:\n  response_header: 300\n  stream_idle: 600\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((l) => /disabled/i.test(l))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("absent timeouts section → NO warning (bundled defaults are positive)", async () => {
    await writeConfig("history:\n  limit: 5\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((l) => /disabled/i.test(l))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("unchanged config on re-apply does NOT re-warn (no per-request spam)", async () => {
    await writeConfig("timeouts:\n  response_header: 0\n")
    // First apply warns.
    await applyConfigToState()
    // Second apply (same mtime) must be silent — mirrors the per-request
    // hot-reload path that calls applyConfigToState on every request.
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((l) => /disabled/i.test(l))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

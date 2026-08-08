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

describe("wall-clock bounded-wait override warning", () => {
  test.each([
    ["response_header", "TTFB"],
    ["stream_idle", "mid-stream silence"],
    ["stale_request_max_age", "active upstream lifetime"],
    ["request_deadline", "client request lifetime"],
  ])("positive %s warns that legitimate unbounded thinking may be terminated", async (key, label) => {
    await writeConfig(`timeouts:\n  ${key}: 300\n`)
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((line) => line.includes(label) && /legitimate unbounded thinking/i.test(line))).toBeTrue()
    } finally {
      spy.mockRestore()
    }
  })

  test.each([
    ["response_header_overrides", "claude-opus-4.8"],
    ["stream_idle_overrides", "gpt-5.5"],
  ])("positive %s entry names its model in the warning", async (key, model) => {
    await writeConfig(`timeouts:\n  ${key}:\n    ${model}: 600\n`)
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((line) => line.includes(`${key}.${model}=600s`) && /legitimate unbounded thinking/i.test(line))).toBeTrue()
    } finally {
      spy.mockRestore()
    }
  })

  test("zero-valued per-model entries do not warn", async () => {
    await writeConfig("timeouts:\n  response_header_overrides:\n    claude-opus-4.8: 0\n  stream_idle_overrides:\n    gpt-5.5: 0\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((line) => /bounded-wait override/i.test(line))).toBeFalse()
    } finally {
      spy.mockRestore()
    }
  })

  test("all four disabled defaults emit no bounded-wait warning", async () => {
    await writeConfig("timeouts:\n  response_header: 0\n  stream_idle: 0\n  stale_request_max_age: 0\n  request_deadline: 0\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((line) => /bounded-wait override/i.test(line))).toBeFalse()
    } finally {
      spy.mockRestore()
    }
  })

  test("absent timeouts section emits no bounded-wait warning", async () => {
    await writeConfig("history:\n  limit: 5\n")
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((line) => /bounded-wait override/i.test(line))).toBeFalse()
    } finally {
      spy.mockRestore()
    }
  })

  test("unchanged positive override does not re-warn on hot re-apply", async () => {
    await writeConfig("timeouts:\n  response_header: 300\n")
    await applyConfigToState()
    const spy = spyOn(consola, "warn")
    try {
      await applyConfigToState()
      expect(warnLines(spy).some((line) => /bounded-wait override/i.test(line))).toBeFalse()
    } finally {
      spy.mockRestore()
    }
  })
})

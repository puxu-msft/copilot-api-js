import {
  //
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  getUpstreamHook,
  getUpstreamHookState,
  loadUpstreamHook,
  resetUpstreamHook,
} from "~/lib/pipeline/hooks/loader"

const fixtureDir = join(import.meta.dir, "fixtures")
const validHookPath = join(fixtureDir, "valid-hook.ts")
const noExportsPath = join(fixtureDir, "no-exports.ts")

beforeEach(() => {
  resetUpstreamHook()
})

describe("loadUpstreamHook", () => {
  test("loads a valid hook module and populates the singleton state", async () => {
    const state = await loadUpstreamHook(validHookPath)

    expect(state.module).toBe(validHookPath)
    expect(state.exports).toContain("onExchange")
    expect(state.version).toBe(String(state.loadedAt))

    const hook = getUpstreamHook()
    expect(hook).toBeDefined()
    expect(typeof hook?.onExchange).toBe("function")

    expect(getUpstreamHookState()).toBe(state)
  })

  test("throws when the module exports no recognized hook mount point", async () => {
    await expect(loadUpstreamHook(noExportsPath)).rejects.toThrow("exports none of")
  })

  test("resetUpstreamHook clears the singleton", async () => {
    await loadUpstreamHook(validHookPath)
    expect(getUpstreamHook()).toBeDefined()

    resetUpstreamHook()
    expect(getUpstreamHook()).toBeUndefined()
    expect(getUpstreamHookState()).toBeUndefined()
  })
})

describe("data-URL reload (regression: Bun path-keyed ESM cache bypass)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "hook-reload-"))
  const reloadPath = join(tmp, "reload-tmp.ts")

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("re-loads fresh module source after the file changes on disk", async () => {
    writeFileSync(reloadPath, `export const onExchange = async () => "v1" as any\n`)
    await loadUpstreamHook(reloadPath)
    const v1 = await (getUpstreamHook()?.onExchange as unknown as () => Promise<string>)()
    expect(v1).toBe("v1")

    writeFileSync(reloadPath, `export const onExchange = async () => "v2" as any\n`)
    await loadUpstreamHook(reloadPath)
    const v2 = await (getUpstreamHook()?.onExchange as unknown as () => Promise<string>)()
    expect(v2).toBe("v2")
  })
})

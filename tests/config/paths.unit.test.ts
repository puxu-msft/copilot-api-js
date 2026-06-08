import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const MODULE_PATH = path.resolve(import.meta.dir, "../../src/lib/config/paths.ts")

interface PathsSnapshot {
  APP_DIR: string
  GITHUB_TOKEN_PATH: string
  CONFIG_YAML: string
  LEARNED_LIMITS: string
  REQUEST_TELEMETRY: string
  NEGOTIATION_STATES: string
  HISTORY_DB: string
}

function loadPaths(env: Record<string, string | undefined>): PathsSnapshot {
  const script = `import(${JSON.stringify(MODULE_PATH)}).then(m => { process.stdout.write(JSON.stringify(m.PATHS)) })`
  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "XDG_DATA_HOME") baseEnv[k] = v
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) {
      baseEnv[k] = v
    }
  }
  const result = spawnSync("bun", ["-e", script], {
    env: baseEnv,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`bun eval failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout) as PathsSnapshot
}

describe("config/paths", () => {
  test("uses ~/.local/share/copilot-api when XDG_DATA_HOME unset", () => {
    const paths = loadPaths({ XDG_DATA_HOME: undefined })
    const expected = path.join(os.homedir(), ".local", "share", "copilot-api")
    expect(paths.APP_DIR).toBe(expected)
    expect(paths.CONFIG_YAML).toBe(path.join(expected, "config.yaml"))
    expect(paths.HISTORY_DB).toBe(path.join(expected, "history.db"))
    expect(paths.GITHUB_TOKEN_PATH).toBe(path.join(expected, "github_token"))
  })

  test("honors XDG_DATA_HOME when set", () => {
    const paths = loadPaths({ XDG_DATA_HOME: "/tmp/xdg-test" })
    const expected = path.join("/tmp/xdg-test", "copilot-api")
    expect(paths.APP_DIR).toBe(expected)
    expect(paths.CONFIG_YAML).toBe(path.join(expected, "config.yaml"))
    expect(paths.HISTORY_DB).toBe(path.join(expected, "history.db"))
    expect(paths.LEARNED_LIMITS).toBe(path.join(expected, "learned-limits.json"))
    expect(paths.NEGOTIATION_STATES).toBe(path.join(expected, "negotiation-states.json"))
  })

  test("falls back to default when XDG_DATA_HOME is empty string", () => {
    const paths = loadPaths({ XDG_DATA_HOME: "" })
    const expected = path.join(os.homedir(), ".local", "share", "copilot-api")
    expect(paths.APP_DIR).toBe(expected)
  })
})

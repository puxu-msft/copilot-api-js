/**
 * applyConfigToState() wiring for the three-axis transport config reorg —
 * config.upstream_transport.* / config.server.responses_ws.* must reach the
 * matching state setters (plan-1 Task 7).
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
import { state } from "~/lib/state"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

async function writeConfig(content: string): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transport-config-apply-"))
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

describe("applyConfigToState — upstream_transport.* / server.responses_ws.*", () => {
  test("upstream_transport.tcp_keepalive_probe_delay reaches state.upstreamKeepaliveDelay", async () => {
    await writeConfig("upstream_transport:\n  tcp_keepalive_probe_delay: 22\n")
    await applyConfigToState()
    expect(state.upstreamKeepaliveDelay).toBe(22)
  })

  test("upstream_transport.http2.ping_interval reaches state.upstreamH2PingInterval", async () => {
    await writeConfig("upstream_transport:\n  http2:\n    ping_interval: 33\n")
    await applyConfigToState()
    expect(state.upstreamH2PingInterval).toBe(33)
  })

  test("upstream_transport.http2.favor reaches state.upstreamH2Favor", async () => {
    await writeConfig("upstream_transport:\n  http2:\n    favor: false\n")
    await applyConfigToState()
    expect(state.upstreamH2Favor).toBe(false)
  })

  test("upstream_transport.http2.favor=false logs a loud warning under Bun (only signal that https will hang)", async () => {
    // The unit tier runs under Bun (`typeof Bun !== 'undefined'`), which is exactly
    // the runtime where favor:false bricks every https upstream (undici hangs on
    // GHC's chunked responses). Lock the operator-facing warning so a future
    // refactor can't silently drop it or invert the runtime guard.
    const warnSpy = spyOn(consola, "warn").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.warn)
    try {
      await writeConfig("upstream_transport:\n  http2:\n    favor: false\n")
      await applyConfigToState()
      const messages = warnSpy.mock.calls.map((call: Array<unknown>) => String(call[0]))
      expect(messages.some((m) => m.includes("favor") && m.toLowerCase().includes("bun"))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("upstream_transport.http2.favor=true does NOT warn", async () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.warn)
    try {
      await writeConfig("upstream_transport:\n  http2:\n    favor: true\n")
      await applyConfigToState()
      const messages = warnSpy.mock.calls.map((call: Array<unknown>) => String(call[0]))
      expect(messages.some((m) => m.includes("favor"))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("upstream_transport.http2.session_connect_timeout reaches state.sessionConnectTimeout", async () => {
    await writeConfig("upstream_transport:\n  http2:\n    session_connect_timeout: 7\n")
    await applyConfigToState()
    expect(state.sessionConnectTimeout).toBe(7)
  })

  test("upstream_transport.websocket.pooled_connection_idle_timeout reaches state.pooledConnectionIdleTimeout", async () => {
    await writeConfig("upstream_transport:\n  websocket:\n    pooled_connection_idle_timeout: 120\n")
    await applyConfigToState()
    expect(state.pooledConnectionIdleTimeout).toBe(120)
  })

  test("upstream_transport.websocket.soft_max_connections reaches state.softMaxUpstreamWsConnections", async () => {
    await writeConfig("upstream_transport:\n  websocket:\n    soft_max_connections: 9\n")
    await applyConfigToState()
    expect(state.softMaxUpstreamWsConnections).toBe(9)
  })

  test("server.responses_ws.keep_open reaches state.clientWebsocketKeepOpen", async () => {
    await writeConfig("server:\n  responses_ws:\n    keep_open: true\n")
    await applyConfigToState()
    expect(state.clientWebsocketKeepOpen).toBe(true)
  })

  test("server.responses_ws.max_frame_bytes reaches state.maxWsFrameBytes", async () => {
    await writeConfig("server:\n  responses_ws:\n    max_frame_bytes: 4096\n")
    await applyConfigToState()
    expect(state.maxWsFrameBytes).toBe(4096)
  })

  test("server.responses_ws.max_connections reaches state.maxClientWsConnections", async () => {
    await writeConfig("server:\n  responses_ws:\n    max_connections: 12\n")
    await applyConfigToState()
    expect(state.maxClientWsConnections).toBe(12)
  })
})

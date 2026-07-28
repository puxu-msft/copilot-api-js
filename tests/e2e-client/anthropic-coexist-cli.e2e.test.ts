/**
 * client↔proxy CLI e2e (Anthropic, Tier 2) — real `claude` CLI complement to the Tier-1 SDK
 * anchor-coexist test (anthropic-buffered.it.test.ts, P1 criterion ①).
 *
 * The Tier-1 SDK test proved the real `@anthropic-ai/sdk` accumulator ACCEPTS the block-level
 * buffered-retry "anchor-coexist" wire (an empty-text anchor block@0 that stays open across real
 * blocks@1/@2, closing off only at the terminal). That is necessary-but-not-sufficient: the real
 * Claude Code CLI runs a separate, possibly-stricter agent-loop state machine ON TOP of the SDK.
 * This test drives the REAL `claude` CLI against a spawned real proxy (non-4141) whose mocked
 * upstream (a config-declared hook) emits exactly that anchor-coexist wire. The CLI does NOT
 * assemble it: the SDK accepts the bytes, but the CLI completes with an empty result. This negative
 * lock is why production uses the sequential close-before-real shape. The 300s-idle-deadline half
 * remains a separate exp/ probe; this wire is short and has no long silence.
 *
 * PROXY CONFIG: `stream_keepalive_mode: ping` (NOT the default `empty_text`) makes
 * `buildAnthropicAnchorHooks` return `undefined` (handler-v4.ts:886,
 * `state.streamKeepaliveMode !== "ping"` gate), so the live path's `makeReconcilingSink` decorator
 * is never applied (`liveReconcilingSink` returns the raw sink unchanged, handler-v4.ts:999-1000) —
 * the hook's wire reaches claude EXACTLY as emitted, unmodified by the proxy's own live-path anchor
 * reconciliation. `protect_streaming_generation: false` (the config.yaml default) additionally keeps
 * this off the buffered/driver-remap path entirely — this is a pure live passthrough of a
 * hook-mocked upstream, verified by construction (both anchorHooks and buffered are inert here; see
 * cli-coexistence-gate-report.md for the full trace).
 *
 * GATED (real e2e, like anthropic-cli.e2e.test.ts): needs `claude` on PATH + a real github_token
 * (boot exchanges it for a copilot token + fetches models over the network) + network. Skipped
 * otherwise, so CI without auth/claude is green. Run deliberately. Uses `.e2e.test.ts` (excluded
 * from the offline test:backend).
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { existsSync } from "node:fs"

import { driveClaudeCli } from "./harness/drive-claude-cli"
import {
  //
  realGithubTokenPath,
  type SpawnedProxy,
  spawnProxy,
} from "./harness/spawn-proxy"

const HOOK = "./tests/e2e-client/harness/cli-anchor-coexist-hook.ts"
const GATED = Boolean(Bun.which("claude")) && existsSync(realGithubTokenPath())

// A unique, non-4141 high port (this test's own proxy, never the user's main server).
const PORT = 41989

const configYaml =
  [
    "hooks:",
    `  upstream_module: "${HOOK}"`,
    "  enabled: true",
    "anthropic:",
    // ping (not the default empty_text): keeps the live-path anchor reconciliation OFF, so the
    // hook's anchor-coexist wire reaches claude byte-for-byte, unmodified by the proxy itself — we
    // are testing claude's acceptance of the WIRE SHAPE, not the proxy's own anchor machinery.
    "  stream_keepalive_mode: ping",
    "  protect_streaming_generation: false",
  ].join("\n") + "\n"

describe.skipIf(!GATED)("client↔proxy CLI e2e (real claude → real proxy → hook-mock anchor-coexist wire)", () => {
  test("anchor-coexist wire is CLI-unsafe: Claude completes the turn without assembling the real text", async () => {
    let proxy: SpawnedProxy | undefined
    try {
      proxy = await spawnProxy({ port: PORT, configYaml })
      const loaded = await proxy.reloadHook()
      expect(loaded.ok, `hook load failed: ${loaded.error}`).toBe(true)
      expect(loaded.exports).toContain("exchange")

      const r = driveClaudeCli({ baseURL: proxy.baseURL, prompt: "say hello", model: "claude-sonnet-4.6" })

      // The current CLI terminates the turn but drops the real text assembled under the coexisting
      // anchor. This is the empirical rejection of coexistence; production must remain sequential.
      expect(r.numTurns).toBe(1)
      expect(r.result).toBe("")
    } finally {
      proxy?.close()
    }
  }, 90_000)
})

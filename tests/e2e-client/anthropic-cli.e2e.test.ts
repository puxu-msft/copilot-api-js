/**
 * client↔proxy CLI e2e (Anthropic, Tier 2) — the REAL `claude` CLI drives the REAL proxy.
 *
 * Unlike the SDK tier (anthropic-sdk.it.test.ts, in-process, wire-contract oracle), this drives the
 * genuine `claude` agent binary against a spawned real proxy (non-4141) whose GHC upstream is mocked
 * by a config-declared hook returning a thinking-only refusal. It asserts an AGENT-LOOP behavior the
 * SDK can't reproduce: whether the empty-string refusal recovery (thinking-only end_turn, no text)
 * STALLS claude — the verdict flagged as "needs a live oracle" in the refusal-text spec.
 *
 * Empirically established (exp/cli-e2e-stall/FINDINGS.md): a thinking-only end_turn makes claude loop
 * (num_turns:2, result:'', upstream hit twice); a non-empty recovery text prevents it (num_turns:1).
 *
 * GATED (real e2e, like tests/e2e/): needs `claude` on PATH + a real github_token (boot exchanges it
 * for a copilot token + fetches models over the network) + network. Skipped otherwise, so CI without
 * auth/claude is green. Run deliberately. Uses `.e2e.test.ts` (excluded from the offline test:backend).
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { existsSync } from "node:fs"

import {
  //
  createClaudeCliSession,
  driveClaudeCli,
} from "./harness/drive-claude-cli"
import {
  //
  realGithubTokenPath,
  type SpawnedProxy,
  spawnProxy,
} from "./harness/spawn-proxy"

const HOOK = "./tests/e2e-client/harness/cli-refusal-hook.ts"
const GATED = Boolean(Bun.which("claude")) && existsSync(realGithubTokenPath())

// A random non-4141 port (never the user's main server).
const port = (mode: "stall" | "recover" | "two-turn"): number => {
  if (mode === "stall") return 41987
  if (mode === "recover") return 41988
  return 41990
}

const configYaml = (refusalEndTurnText: string): string =>
  [
    "hooks:",
    `  upstream_module: "${HOOK}"`,
    "  enabled: true",
    "anthropic:",
    "  refusal_sse_rewrite: end_turn",
    `  refusal_end_turn_text: "${refusalEndTurnText}"`,
  ].join("\n") + "\n"

describe.skipIf(!GATED)("client↔proxy CLI e2e (real claude → real proxy → hook-mock refusal)", () => {
  test("empty-string end_turn STALLS the agent loop (num_turns>1, result empty)", async () => {
    let proxy: SpawnedProxy | undefined
    try {
      proxy = await spawnProxy({ port: port("stall"), configYaml: configYaml("") })
      const loaded = await proxy.reloadHook()
      expect(loaded.ok, `hook load failed: ${loaded.error}`).toBe(true)
      expect(loaded.exports).toContain("exchange")

      const r = driveClaudeCli({ baseURL: proxy.baseURL, prompt: "say hello" })
      // STALL signature: the agent looped on the empty (thinking-only) turn and surfaced nothing.
      expect(r.numTurns).toBeGreaterThan(1)
      expect(r.result).toBe("")
    } finally {
      proxy?.close()
    }
  }, 90_000)

  test("non-empty recovery text PREVENTS the stall (num_turns==1, result non-empty)", async () => {
    let proxy: SpawnedProxy | undefined
    try {
      const recoveryText = "RECOVERY_TEXT_MARKER — upstream refused; rephrase and retry."
      proxy = await spawnProxy({ port: port("recover"), configYaml: configYaml(recoveryText) })
      const loaded = await proxy.reloadHook()
      expect(loaded.ok, `hook load failed: ${loaded.error}`).toBe(true)

      const r = driveClaudeCli({ baseURL: proxy.baseURL, prompt: "say hello" })
      // No stall: the injected recovery text gives the agent a coherent, non-empty turn.
      expect(r.numTurns).toBe(1)
      expect(r.result).toContain("RECOVERY_TEXT_MARKER")
    } finally {
      proxy?.close()
    }
  }, 90_000)

  test("suppressed refusal leaves the SAME session usable for a normal second user turn", async () => {
    let proxy: SpawnedProxy | undefined
    try {
      const recoveryText = "RECOVERY_TEXT_MARKER — upstream refused; rephrase and retry."
      proxy = await spawnProxy({ port: port("two-turn"), configYaml: configYaml(recoveryText) })
      const loaded = await proxy.reloadHook()
      expect(loaded.ok, `hook load failed: ${loaded.error}`).toBe(true)
      expect(loaded.exports).toContain("exchange")

      const session = createClaudeCliSession({ baseURL: proxy.baseURL })
      const first = session.run("FIRST_USER_TURN_REQUEST")
      expect(first.sessionId).toBe(session.sessionId)
      expect(first.numTurns).toBe(1)
      expect(first.result).toContain("RECOVERY_TEXT_MARKER")
      expect(first.isError).toBe(false)
      expect(first.exitCode, first.stderr).toBe(0)
      expect(first.stderr).toBe("")

      const second = session.run("SECOND_USER_TURN_REQUEST")
      // Direct oracle for the primary goal: this is the persisted conversation, not a fresh CLI run.
      expect(second.sessionId).toBe(session.sessionId)
      expect(second.result).toContain("SECOND_TURN_OK_MARKER")
      expect(second.result).not.toBe("")
      // Any automatic "continue" cycle inside this invocation increments num_turns beyond one.
      expect(second.numTurns).toBe(1)
      expect(second.isError).toBe(false)
      expect(second.exitCode, second.stderr).toBe(0)
      expect(second.stderr).toBe("")
    } finally {
      proxy?.close()
    }
  }, 120_000)
})

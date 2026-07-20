import { spawnSync } from "bun"
import {
  //
  mkdtempSync,
  writeFileSync,
} from "node:fs"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The client-observable result of a `claude -p` run. */
export interface ClaudeCliResult {
  /** The final assistant text the user would see ('' when the turn had no visible content). */
  result: string
  /** How many agent turns claude took (>1 = it looped on an empty/unsatisfying turn). */
  numTurns: number
  stopReason: string
  isError: boolean
}

/**
 * Drive the REAL `claude` CLI in non-interactive print mode against `baseURL`, returning the parsed
 * `--output-format json` result. Uses an ISOLATED HOME (so the user's subscription auth + real
 * ~/.claude are never touched/used) wired the way `src/setup-claude-code.ts` does:
 * `ANTHROPIC_AUTH_TOKEN` (NOT ANTHROPIC_API_KEY — subscription OAuth overrides API_KEY) +
 * `ANTHROPIC_BASE_URL` + `.claude.json` with `hasCompletedOnboarding:true`.
 */
export function driveClaudeCli(opts: { baseURL: string; prompt: string; model?: string; timeoutMs?: number }): ClaudeCliResult {
  const model = opts.model ?? "claude-sonnet-4.6"
  const home = mkdtempSync(join(tmpdir(), "cli-e2e-home-"))
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: opts.baseURL,
        ANTHROPIC_AUTH_TOKEN: "copilot-api",
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      },
    }),
  )

  const proc = spawnSync(["claude", "-p", opts.prompt, "--model", model, "--output-format", "json"], {
    env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: opts.baseURL, ANTHROPIC_AUTH_TOKEN: "copilot-api" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 45_000,
  })

  const out = proc.stdout.toString()
  const parsed = JSON.parse(out) as { result?: string; num_turns?: number; stop_reason?: string; is_error?: boolean }
  return {
    result: parsed.result ?? "",
    numTurns: parsed.num_turns ?? 0,
    stopReason: parsed.stop_reason ?? "",
    isError: parsed.is_error ?? false,
  }
}

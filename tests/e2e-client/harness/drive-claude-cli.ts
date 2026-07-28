import { spawnSync } from "bun"
import { randomUUID } from "node:crypto"
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
  /** Process exit code (`null` only if the runtime could not report one). */
  exitCode: number | null
  /** Non-empty stderr is retained so malformed-stream failures cannot masquerade as empty results. */
  stderr: string
  /** The persisted Claude Code conversation ID reported by the CLI. */
  sessionId: string
}

export interface ClaudeCliSession {
  /** The explicit UUID passed to `--session-id` on turn 1 and `--resume` thereafter. */
  sessionId: string
  /** Run one user turn in this persisted conversation. */
  run: (prompt: string) => ClaudeCliResult
}

interface ClaudeCliOptions {
  baseURL: string
  model?: string
  timeoutMs?: number
}

/**
 * Create a persisted REAL `claude` CLI conversation against `baseURL`. Every turn shares one
 * ISOLATED HOME and one explicit session ID: turn 1 uses `--session-id`, later turns use `--resume`.
 * The user's subscription auth, session store, and real `~/.claude` are never touched.
 */
export function createClaudeCliSession(opts: ClaudeCliOptions): ClaudeCliSession {
  const model = opts.model ?? "claude-sonnet-4.6"
  const home = mkdtempSync(join(tmpdir(), "cli-e2e-home-"))
  const sessionId = randomUUID()
  let started = false

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

  return {
    sessionId,
    run: (prompt: string) => {
      const sessionArgs = started ? ["--resume", sessionId] : ["--session-id", sessionId]
      const proc = spawnSync(["claude", "-p", prompt, "--model", model, "--output-format", "json", ...sessionArgs], {
        env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: opts.baseURL, ANTHROPIC_AUTH_TOKEN: "copilot-api" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: opts.timeoutMs ?? 45_000,
      })
      started = true

      const out = proc.stdout.toString()
      const parsed = JSON.parse(out) as {
        result?: string
        num_turns?: number
        stop_reason?: string
        is_error?: boolean
        session_id?: string
      }
      return {
        result: parsed.result ?? "",
        numTurns: parsed.num_turns ?? 0,
        stopReason: parsed.stop_reason ?? "",
        isError: parsed.is_error ?? false,
        exitCode: proc.exitCode,
        stderr: proc.stderr.toString(),
        sessionId: parsed.session_id ?? "",
      }
    },
  }
}

/** Drive one standalone REAL `claude -p` turn. Multi-turn tests should use `createClaudeCliSession`. */
export function driveClaudeCli(opts: ClaudeCliOptions & { prompt: string }): ClaudeCliResult {
  return createClaudeCliSession(opts).run(opts.prompt)
}

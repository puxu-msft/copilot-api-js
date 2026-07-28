// Q1 first-failure-point probe — client side.
//
// Drives the REAL Claude Code CLI (not the SDK) against the abort-observer
// server, with an isolated HOME so the run cannot read or write the user's real
// ~/.claude. CC's own retry behaviour is left at its defaults: each retry shows
// up server-side as a fresh inbound request, which is exactly the signal we want
// to record. A hard wall-clock cap keeps a retrying client from running forever.
//
// Env:
//   Q1_BASE_URL          proxy base URL (the abort-observer server)
//   Q1_CAP_MS            hard cap on the CLI process
//   Q1_RESULTS_PATH      where to write the run record

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const baseURL = process.env.Q1_BASE_URL
const capMs = Number.parseInt(process.env.Q1_CAP_MS ?? "", 10)
const resultsPath = process.env.Q1_RESULTS_PATH
if (!baseURL || !resultsPath || !Number.isFinite(capMs)) throw new Error("Q1_BASE_URL, Q1_CAP_MS and Q1_RESULTS_PATH are required")

mkdirSync(dirname(resultsPath), { recursive: true })
const home = mkdtempSync(join(tmpdir(), "silence-q1-firstfail-"))
mkdirSync(join(home, ".claude"), { recursive: true })
writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
writeFileSync(
  join(home, ".claude", "settings.json"),
  JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseURL,
      ANTHROPIC_AUTH_TOKEN: "copilot-api",
      ANTHROPIC_MODEL: "claude-sonnet-4.6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4.6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4.6",
    },
  }),
)

const startedAt = Date.now()
const proc = Bun.spawn(["claude", "-p", "Reply with exactly OK", "--model", "claude-sonnet-4.6", "--output-format", "json"], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: "copilot-api" },
  stdout: "pipe",
  stderr: "pipe",
})

let cappedOut = false
const capTimer = setTimeout(() => {
  cappedOut = true
  proc.kill()
}, capMs)

const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
clearTimeout(capTimer)

let parsed: Record<string, unknown> = {}
try {
  parsed = JSON.parse(stdout) as Record<string, unknown>
} catch {
  // Non-JSON stdout is itself a finding (CC printed an error banner instead of
  // its --output-format json envelope); the raw text is kept in the record.
}

const record = { baseURL, capMs, cappedOut, exitCode, elapsedMs: Date.now() - startedAt, home, stdout, stderr, parsed }
writeFileSync(resultsPath, JSON.stringify(record, null, 2) + "\n")
console.log(JSON.stringify({ cappedOut, exitCode, elapsedMs: record.elapsedMs, result: parsed.result, isError: parsed.is_error, numTurns: parsed.num_turns, stderrHead: stderr.slice(0, 400) }))

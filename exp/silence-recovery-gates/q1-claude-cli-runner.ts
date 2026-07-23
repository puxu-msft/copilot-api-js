import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const baseURL = process.env.Q1_BASE_URL
const delayMs = Number.parseInt(process.env.Q1_DELAY_MS ?? "0", 10)
const resultsPath = process.env.Q1_RESULTS_PATH
if (!baseURL || !resultsPath || !Number.isFinite(delayMs)) throw new Error("Q1_BASE_URL, Q1_DELAY_MS, and Q1_RESULTS_PATH are required")

mkdirSync(new URL(".", `file://${resultsPath}`).pathname, { recursive: true })
const home = mkdtempSync(join(tmpdir(), "silence-q1-claude-"))
mkdirSync(join(home, ".claude"), { recursive: true })
writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: "copilot-api", ANTHROPIC_MODEL: "claude-sonnet-4.6", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4.6", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4.6" } }))
const startedAt = Date.now()
const proc = Bun.spawnSync(["claude", "-p", "Reply with exactly OK", "--model", "claude-sonnet-4.6", "--output-format", "json"], { env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: "copilot-api" }, stdout: "pipe", stderr: "pipe" })
const stdout = proc.stdout.toString()
const stderr = proc.stderr.toString()
let parsed: Record<string, unknown> = {}
try { parsed = JSON.parse(stdout) as Record<string, unknown> } catch {}
const record = { delayMs, baseURL, exitCode: proc.exitCode, elapsedMs: Date.now() - startedAt, stdout, stderr, parsed }
writeFileSync(resultsPath, JSON.stringify(record, null, 2) + "\n")
console.log(JSON.stringify({ delayMs, exitCode: proc.exitCode, elapsedMs: record.elapsedMs, result: parsed.result, numTurns: parsed.num_turns, stderr: stderr.slice(0, 300) }))
if (proc.exitCode !== 0) process.exitCode = proc.exitCode ?? 1

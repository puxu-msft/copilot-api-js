// Q1 layer-attribution control for the 300s pre-header ceiling.
//
// Both real Claude Code and the standalone Anthropic SDK abandon a silent
// pre-header request at ~300.0s despite being configured with far longer
// timeouts (1200s / 1250s). That points below both of them, at undici's default
// `headersTimeout` in Node's fetch. This probe removes every Anthropic layer:
// bare `fetch`, no SDK, no CC. If it also dies at ~300s with a headers-timeout
// cause, the ceiling belongs to the HTTP client stack and no Anthropic-level or
// CC-level knob can move it.
//
// The client-side record is written to disk, not just printed: the verdict rests
// on the error CAUSE (UND_ERR_HEADERS_TIMEOUT), and a server-side observation
// only ever shows "the client left" — it cannot distinguish which layer decided.
// The runtime versions go in the same record because "undici's default" is a
// property of a specific Node build, not a protocol constant.
//
// Env: Q1_BASE_URL, Q1_RESULTS_PATH

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const baseURL = process.env.Q1_BASE_URL
const resultsPath = process.env.Q1_RESULTS_PATH
if (!baseURL || !resultsPath) throw new Error("Q1_BASE_URL and Q1_RESULTS_PATH are required")

mkdirSync(dirname(resultsPath), { recursive: true })

const runtime = {
  argv0: process.argv0,
  version: process.version,
  versions: { node: process.versions.node, undici: (process.versions as Record<string, string | undefined>).undici ?? null },
}

const startedAt = Date.now()
let record: Record<string, unknown>
try {
  const response = await fetch(`${baseURL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  record = { status: "headers-received", elapsedMs: Date.now() - startedAt, httpStatus: response.status, runtime }
} catch (error) {
  const e = error instanceof Error ? error : new Error(String(error))
  const cause =
    e.cause instanceof Error
      ? { name: e.cause.name, message: e.cause.message, code: (e.cause as unknown as { code?: string }).code ?? null }
      : { raw: String(e.cause ?? "") }
  record = { status: "error", elapsedMs: Date.now() - startedAt, name: e.name, message: e.message, cause, runtime }
}

writeFileSync(resultsPath, JSON.stringify({ baseURL, startedAt: new Date(startedAt).toISOString(), ...record }, null, 2) + "\n")
console.log(JSON.stringify(record))

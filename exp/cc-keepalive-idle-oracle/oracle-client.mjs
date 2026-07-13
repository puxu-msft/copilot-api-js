// Chat Completions keepalive M-2 oracle CLIENT — drives ONE streaming
// `chat.completions.create` call through the copilot-api PROXY using the real, unmodified
// `openai` Node SDK (the same package this repo depends on, `package.json:110`) with NO custom
// timeout/dispatcher override — i.e. the SDK's + Node's OUT-OF-THE-BOX behavior a naive CC
// consumer would get. This is deliberately closer to "the SDK itself" than to Codex CLI (the
// sibling Responses harness's oracle): Chat Completions has no single dominant CLI client the way
// Codex is Responses' dominant client, so the openai-node SDK — the actual decoder GHC users'
// real CC clients are built on — is the most representative, most direct oracle available
// (spec §7.1 M-2: "须独立 oracle 实证，非「加个 keepalive 就默认 true」").
//
// WHY NO CUSTOM TIMEOUT: Node's global fetch (undici under the hood) applies its own DEFAULT
// per-request body-idle timeout (`bodyTimeout`, undici default 300_000ms — see
// node_modules/undici/lib/dispatcher/client.js:261 `this[kBodyTimeout] = bodyTimeout ?? 300e3`,
// enforced per client-h1.js:614-620/687-700 refreshing on every `onBody` chunk). This 300s wall is
// EXACTLY the kind of "no-real-content idle deadline" the spec's M-2 gate is about — a naive
// openai-node consumer (no explicit `timeout:` option, no custom `fetchOptions.dispatcher`) will
// have its underlying HTTP client silently kill the connection after 300s of ZERO bytes, wrapped
// by the SDK as a generic fetch failure. A real proxy-injected keepalive CHUNK (not a bare
// comment) resets this exactly the way a real content byte would (undici's TIMEOUT_BODY handler
// refreshes on every `onBody` call, chunk or otherwise — see mock-upstream.ts header + REPORT.md
// §0 for the verified probe). This is the oracle's load-bearing wall — empirically confirmed
// during this harness's construction (see REPORT.md §0: a bare content-array-only fetch reader
// against a Node http server with a >300s silence dies at ~300.0s with `TypeError: terminated`
// when NO keepalive chunk is injected, and survives past 300s when a chunk arrives every <300s).
//
// Usage: node oracle-client.mjs <label> <proxyUrl> <silenceSec> <ceilSec>
//   label      : armPing | armSilent (log/echo only)
//   proxyUrl   : e.g. http://localhost:4143
//   silenceSec : informational only (drives the wall-clock ceiling default)
//   ceilSec    : hard wall-clock cutoff for this script (> silenceSec + margin)
//
// Prints a single JSON line to stdout on completion:
//   {"label":..., "is_error":bool, "duration_ms":number, "chunks":number, "error":string|null}
// so run-proxy-arm.sh can extract the verdict with `jq` exactly like the sibling harness does
// for codex's `--json` event stream.

import OpenAI from "openai"

const [, , label, proxyUrl, silenceSecArg, ceilSecArg] = process.argv
if (!label || !proxyUrl) {
  console.error("usage: node oracle-client.mjs <label> <proxyUrl> [silenceSec] [ceilSec]")
  process.exit(2)
}
const silenceSec = Number(silenceSecArg ?? 330)
const ceilSec = Number(ceilSecArg ?? 420)
const model = process.env.MOCK_MODEL_ID ?? "gpt-5.4"

async function main() {
  // Deliberately NO `timeout:` option and NO custom `fetchOptions.dispatcher` — the SDK's +
  // Node's stock defaults are exactly what's under test (see file header).
  const client = new OpenAI({ apiKey: "dummy", baseURL: `${proxyUrl}/v1` })
  const start = Date.now()
  let chunks = 0
  const ceilTimer = setTimeout(() => {
    console.error(`[${label}] wall-clock ceiling (${ceilSec}s) hit — killing process`)
    process.exit(124)
  }, ceilSec * 1000)
  ceilTimer.unref?.()

  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "reply with the single word: ok" }],
      stream: true,
    })
    for await (const chunk of stream) {
      chunks++
      const delta = chunk.choices?.[0]?.delta
      const finish = chunk.choices?.[0]?.finish_reason
      console.error(`[${label}] chunk#${chunks} at +${((Date.now() - start) / 1000).toFixed(1)}s delta=${JSON.stringify(delta)} finish_reason=${finish ?? "null"}`)
    }
    const duration_ms = Date.now() - start
    console.error(`[${label}] STREAM COMPLETE at +${(duration_ms / 1000).toFixed(1)}s chunks=${chunks}`)
    console.log(JSON.stringify({ label, is_error: false, duration_ms, chunks, error: null }))
  } catch (e) {
    const duration_ms = Date.now() - start
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.error(`[${label}] ERROR at +${(duration_ms / 1000).toFixed(1)}s: ${message}`)
    console.log(JSON.stringify({ label, is_error: true, duration_ms, chunks, error: message }))
  } finally {
    clearTimeout(ceilTimer)
  }
}

await main()

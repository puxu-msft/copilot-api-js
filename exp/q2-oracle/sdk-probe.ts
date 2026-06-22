// Part (b) oracle: how does the REAL @anthropic-ai/sdk (0.105.0 — the version this proxy + Claude Code share)
// react to a streaming `200 + event:error` frame vs a real HTTP 4xx? This is the make-or-break for ③:
// the RFC's §4.2.5 static claim (200+SSE-error => bare APIError, status=undefined, NOT RateLimitError,
// zero auto-retry) must be confirmed BEHAVIORALLY against the independent oracle (the SDK itself).
//
// For each status in {429,401,400} we present BOTH shapes via the mock's x-mock-mode header and record:
//   - error constructor name + instanceof {APIError, RateLimitError, AuthenticationError, BadRequestError}
//   - .status  (undefined for stream-error => SDK cannot branch on it)
//   - .error?.type  (the canonical literal a client branches on)
//   - attemptCount  (custom fetch counts every HTTP attempt => detects auto-retry)
//   - retry_after visibility
//
// Run: bun run exp/q2-oracle/sdk-probe.ts   (mock must be listening on MOCK_PORT)

import Anthropic, { APIError, RateLimitError, AuthenticationError, BadRequestError } from "@anthropic-ai/sdk"

const PORT = Number(process.env.MOCK_PORT ?? 8788)
const BASE = `http://localhost:${PORT}`

interface Probe {
  scenario: string
  mode: string
  errorClass: string
  isAPIError: boolean
  isRateLimit: boolean
  isAuth: boolean
  isBadRequest: boolean
  status: unknown
  errorType: unknown
  retryAfterVisible: unknown
  attemptCount: number
  message: string
}

async function probe(scenario: string, mode: string, maxRetries: number): Promise<Probe> {
  let attemptCount = 0
  const countingFetch: typeof fetch = (input, init) => {
    attemptCount++
    return fetch(input, init)
  }
  const client = new Anthropic({
    apiKey: "dummy-key",
    baseURL: BASE,
    maxRetries,
    fetch: countingFetch,
    defaultHeaders: { "x-mock-mode": mode },
  })

  let err: unknown
  try {
    const stream = client.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    })
    // consume — the stream-error throws during iteration (streaming.js:113), not at create()
    for await (const _ of stream) void _
  } catch (e) {
    err = e
  }

  const anyErr = err as { constructor?: { name?: string }; status?: unknown; error?: { type?: unknown; error?: { type?: unknown; retry_after?: unknown } }; message?: string; headers?: unknown }
  // retry_after can surface either on parsed body or response headers depending on shape
  let retryAfterVisible: unknown = undefined
  const bodyErr = anyErr?.error as { error?: { retry_after?: unknown; type?: unknown }; type?: unknown } | undefined
  if (bodyErr?.error?.retry_after !== undefined) retryAfterVisible = bodyErr.error.retry_after
  const hdrs = (anyErr?.headers ?? undefined) as { get?: (k: string) => string | null } | undefined
  if (retryAfterVisible === undefined && hdrs?.get) retryAfterVisible = hdrs.get("retry-after") ?? undefined

  // error.type lives at body.error.type for both shapes
  const errorType = bodyErr?.error?.type ?? bodyErr?.type

  return {
    scenario,
    mode,
    errorClass: err ? (err as object).constructor.name : "(no error thrown)",
    isAPIError: err instanceof APIError,
    isRateLimit: err instanceof RateLimitError,
    isAuth: err instanceof AuthenticationError,
    isBadRequest: err instanceof BadRequestError,
    status: (err as { status?: unknown })?.status,
    errorType,
    retryAfterVisible,
    attemptCount,
    message: ((err as { message?: string })?.message ?? "").slice(0, 120),
  }
}

async function main() {
  const results: Array<Probe> = []
  // maxRetries=0 for fidelity (single attempt, inspect fields cleanly)
  for (const code of [429, 401, 400]) {
    results.push(await probe(`HTTP-${code} (real-anthropic)`, `http-error:${code}:0`, 0))
    results.push(await probe(`200+SSE-error-${code} (③ post-commit)`, `sse-error:${code}`, 0))
  }
  // retry detection: maxRetries=2, no retry-after (fast backoff). Compare attemptCount.
  results.push(await probe(`HTTP-429 retry?`, `http-error:429:0`, 2))
  results.push(await probe(`200+SSE-error-429 retry?`, `sse-error:429`, 2))
  // also: commit-then-error (mid-stream error after message_start) — how does SDK surface it?
  results.push(await probe(`commit-then-error-429 (mid-stream)`, `commit-then-error:429:1`, 2))

  console.log(JSON.stringify(results, null, 2))
  console.log("\n=== SUMMARY TABLE ===")
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n)
  console.log(pad("scenario", 36), pad("class", 18), pad("status", 10), pad("err.type", 22), pad("retry_after", 12), "attempts")
  for (const r of results) {
    console.log(
      pad(r.scenario, 36),
      pad(r.errorClass, 18),
      pad(String(r.status), 10),
      pad(String(r.errorType), 22),
      pad(String(r.retryAfterVisible), 12),
      r.attemptCount,
    )
  }
}

void main()

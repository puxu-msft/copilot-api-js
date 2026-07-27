// Layer-attribution control for the 300s pre-header ceiling.
//
// Both real Claude Code and the standalone Anthropic SDK abandon a silent
// pre-header request at ~300.0s despite being configured with far longer
// timeouts (1200s / 1250s). That points below both of them, at undici's default
// `headersTimeout` in Node's fetch. This probe removes every Anthropic layer:
// bare `fetch`, no SDK, no CC. If it also dies at ~300s with a headers-timeout
// cause, the ceiling belongs to the HTTP client stack and no Anthropic-level or
// CC-level knob can move it.
//
// Env: Q1_BASE_URL

const baseURL = process.env.Q1_BASE_URL
if (!baseURL) throw new Error("Q1_BASE_URL is required")

const startedAt = Date.now()
try {
  const response = await fetch(`${baseURL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  console.log(JSON.stringify({ status: "headers-received", elapsedMs: Date.now() - startedAt, httpStatus: response.status }))
} catch (error) {
  const e = error instanceof Error ? error : new Error(String(error))
  const cause = e.cause instanceof Error ? { name: e.cause.name, message: e.cause.message, code: (e.cause as unknown as { code?: string }).code } : { raw: String(e.cause ?? "") }
  console.log(JSON.stringify({ status: "error", elapsedMs: Date.now() - startedAt, name: e.name, message: e.message, cause }))
}

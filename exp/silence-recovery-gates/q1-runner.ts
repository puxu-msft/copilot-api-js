import Anthropic from "@anthropic-ai/sdk"
import { mkdirSync, writeFileSync } from "node:fs"

const baseURL = process.env.Q1_BASE_URL
const delayMs = Number.parseInt(process.env.Q1_DELAY_MS ?? "0", 10)
const resultsPath = process.env.Q1_RESULTS_PATH
if (!baseURL || !resultsPath || !Number.isFinite(delayMs)) throw new Error("Q1_BASE_URL, Q1_DELAY_MS, and Q1_RESULTS_PATH are required")

mkdirSync(new URL(".", `file://${resultsPath}`).pathname, { recursive: true })
const startedAt = Date.now()
const client = new Anthropic({
  apiKey: "copilot-api",
  baseURL,
  timeout: 1_250_000,
  maxRetries: 0,
})

let outcome: Record<string, unknown>
try {
  const stream = client.messages.stream({
    model: "claude-sonnet-4.6",
    max_tokens: 8,
    messages: [{ role: "user", content: "Reply with exactly OK" }],
  })
  const message = await stream.finalMessage()
  outcome = {
    status: "ok",
    elapsedMs: Date.now() - startedAt,
    stopReason: message.stop_reason,
    text: message.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
  }
} catch (error) {
  const e = error instanceof Error ? error : new Error(String(error))
  outcome = { status: "error", elapsedMs: Date.now() - startedAt, name: e.name, message: e.message, cause: String(e.cause ?? "") }
}

const record = { delayMs, baseURL, startedAt: new Date(startedAt).toISOString(), ...outcome }
writeFileSync(resultsPath, JSON.stringify(record, null, 2) + "\n")
console.log(JSON.stringify(record))
if (outcome.status !== "ok") process.exitCode = 1

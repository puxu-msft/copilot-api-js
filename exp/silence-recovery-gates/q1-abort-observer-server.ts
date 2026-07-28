// Q1 first-failure-point probe — server side.
//
// The ladder approach ("try 130s, try 180s, ...") burns wall time and only ever
// brackets the answer. This server instead stays silent for a window far beyond
// any plausible client tolerance and records, per inbound request, the exact
// moment the client gives up (`request.signal` aborts on disconnect). One run
// yields the first-failure point directly, plus the retry behaviour that follows
// it — a ladder rung can only ever say "pass" or "fail".
//
// Env:
//   Q1_PORT                  listen port (never 4141 — the user's main server)
//   Q1_NONCE                 health-endpoint identity, so a caller can prove it
//                            reached THIS process and not a peer's listener
//   Q1_SILENCE_WINDOW_MS     how long to stay silent before answering normally
//   Q1_OBSERVATIONS_PATH     where to append the per-request observation JSON

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const port = Number.parseInt(process.env.Q1_PORT ?? "", 10)
const windowMs = Number.parseInt(process.env.Q1_SILENCE_WINDOW_MS ?? "", 10)
const nonce = process.env.Q1_NONCE
const observationsPath = process.env.Q1_OBSERVATIONS_PATH
if (!nonce || !observationsPath) throw new Error("Q1_NONCE and Q1_OBSERVATIONS_PATH are required")
if (!Number.isFinite(port) || port === 4141) throw new Error("invalid Q1_PORT (4141 is the user's main server and is never allowed)")
if (!Number.isFinite(windowMs) || windowMs < 0) throw new Error("invalid Q1_SILENCE_WINDOW_MS")

mkdirSync(dirname(observationsPath), { recursive: true })

interface Observation {
  attempt: number
  path: string
  method: string
  arrivedAtMs: number
  /** Wall-clock ms from request arrival to the client abandoning the connection. */
  abortedAfterMs: number | null
  /** Set when the silence window elapsed and we answered instead. */
  answeredAfterMs: number | null
  headers: Record<string, string>
}

const startedAt = Date.now()
const observations: Array<Observation> = []
const probes: Array<{ path: string, method: string, atMs: number, userAgent: string }> = []
let attempts = 0

const flush = () => {
  writeFileSync(
    observationsPath,
    JSON.stringify({ port, nonce, windowMs, serverStartedAt: new Date(startedAt).toISOString(), attempts, observations, probes }, null, 2) + "\n",
  )
}
flush()

const encoder = new TextEncoder()
const successFrames = (label: string) =>
  [
    ["message_start", { type: "message_start", message: { id: "msg_q1_abort", type: "message", role: "assistant", model: "claude-sonnet-4.6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: label } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const

const server = Bun.serve({
  // The whole point is to hold a request open for many minutes, so Bun's own
  // per-request idle timeout has to be disabled or it would fire first and we
  // would be measuring Bun, not the client.
  idleTimeout: 0,
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ status: "healthy", nonce, windowMs, attempts, observations })
    if (url.pathname === "/observations") return Response.json({ attempts, observations, probes })
    // CC probes the base URL with `HEAD /api/hello` before it dispatches. Holding
    // that open for the silence window would both stall startup and consume an
    // observation slot, muddling the attempt numbering we read the answer from.
    if (url.pathname === "/api/hello") {
      probes.push({ path: url.pathname, method: request.method, atMs: Date.now() - startedAt, userAgent: request.headers.get("user-agent") ?? "" })
      flush()
      return new Response("ok")
    }

    attempts += 1
    const observation: Observation = {
      attempt: attempts,
      path: url.pathname,
      method: request.method,
      arrivedAtMs: Date.now() - startedAt,
      abortedAfterMs: null,
      answeredAfterMs: null,
      headers: Object.fromEntries(request.headers.entries()),
    }
    observations.push(observation)
    flush()

    const arrivedAt = Date.now()
    const aborted = new Promise<"aborted">((resolve) => {
      if (request.signal.aborted) {
        resolve("aborted")
        return
      }
      request.signal.addEventListener("abort", () => resolve("aborted"), { once: true })
    })
    const elapsed = Bun.sleep(windowMs).then(() => "elapsed" as const)
    const outcome = await Promise.race([aborted, elapsed])

    if (outcome === "aborted") {
      observation.abortedAfterMs = Date.now() - arrivedAt
      flush()
      console.log(JSON.stringify({ event: "client-abort", attempt: observation.attempt, abortedAfterMs: observation.abortedAfterMs }))
      // The client is already gone; the status is irrelevant but the handler
      // must still return something for Bun to retire the connection.
      return new Response("client aborted", { status: 499 })
    }

    observation.answeredAfterMs = Date.now() - arrivedAt
    flush()
    console.log(JSON.stringify({ event: "answered", attempt: observation.attempt, answeredAfterMs: observation.answeredAfterMs }))
    const label = `Q1_PRE_HEADER_OK after ${observation.answeredAfterMs}ms`
    const stream = new ReadableStream({
      start(controller) {
        for (const [event, data] of successFrames(label)) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})

console.log(JSON.stringify({ port: server.port, pid: process.pid, windowMs, nonce, observationsPath }))

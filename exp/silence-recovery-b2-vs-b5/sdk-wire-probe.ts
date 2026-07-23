import Anthropic from "@anthropic-ai/sdk"

type Scenario = {
  readonly name: string
  readonly frames: ReadonlyArray<string>
  readonly expectContent: ReadonlyArray<{ type: "text"; text: string }>
}

const model = "claude-probe"

function event(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

function messageStart(id: string): string {
  return event("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
}

function textBlock(index: number, text: string): ReadonlyArray<string> {
  return [
    event("content_block_start", { index, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index, delta: { type: "text_delta", text } }),
    event("content_block_stop", { index }),
  ]
}

const terminal = [
  event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
  event("message_stop", {}),
]

const ping = event("ping", {})
const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "positive-control",
    frames: [messageStart("msg_control"), ...textBlock(0, "control"), ...terminal],
    expectContent: [{ type: "text", text: "control" }],
  },
  {
    name: "ping-then-fresh-message-start",
    frames: [ping, messageStart("msg_fresh_after_ping"), ...textBlock(0, "B2 default ping splice"), ...terminal],
    expectContent: [{ type: "text", text: "B2 default ping splice" }],
  },
  {
    name: "enveloped-ping-dedup-contract",
    frames: [messageStart("msg_synthetic_envelope"), ping, ...textBlock(0, "B2 enveloped splice"), ...terminal],
    expectContent: [{ type: "text", text: "B2 enveloped splice" }],
  },
  {
    name: "empty-text-close-remap-contract",
    frames: [
      messageStart("msg_synthetic_anchor"),
      ...textBlock(0, ""),
      ...textBlock(1, "B2 empty-text splice"),
      ...terminal,
    ],
    expectContent: [
      { type: "text", text: "" },
      { type: "text", text: "B2 empty-text splice" },
    ],
  },
]

let next = 0
const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 })
    const scenario = scenarios[next++]
    if (!scenario) return new Response("too many requests", { status: 500 })
    return new Response(scenario.frames.join(""), { headers: { "content-type": "text/event-stream" } })
  },
})

try {
  const client = new Anthropic({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: "offline-probe", maxRetries: 0 })
  const results: Array<Record<string, unknown>> = []
  for (const scenario of scenarios) {
    const final = await client.messages.stream({ model, max_tokens: 8, messages: [{ role: "user", content: "probe" }] }).finalMessage()
    const content = final.content.map((block) => ({ type: block.type, ...(block.type === "text" ? { text: block.text } : {}) }))
    if (JSON.stringify(content) !== JSON.stringify(scenario.expectContent)) {
      throw new Error(`${scenario.name}: unexpected SDK accumulation ${JSON.stringify(content)}`)
    }
    results.push({ scenario: scenario.name, content, stop_reason: final.stop_reason })
  }
  if (next !== scenarios.length) throw new Error(`server request count ${next}, expected ${scenarios.length}`)
  console.log(JSON.stringify({ sdk: "@anthropic-ai/sdk 0.106.0", requestCount: next, results }, null, 2))
} finally {
  server.stop(true)
}

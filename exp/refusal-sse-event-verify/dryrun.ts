// Dry-run probe: feed a synthetic thinking-only refusal through the REAL v4 S5 chain
// via /api/debug/dry-run-pipeline (stopAfter=rewrite-out), confirming recover-refusal
// synthesizes a text block + rewrites stop_reason → end_turn on the live server.
const frames = [
  { type: "message_start", raw: JSON.stringify({ type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }) },
  { type: "content_block_start", raw: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) },
  { type: "content_block_delta", raw: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "PROBESIG123" } }) },
  { type: "content_block_stop", raw: JSON.stringify({ type: "content_block_stop", index: 0 }) },
  { type: "message_delta", raw: JSON.stringify({ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: "probe" }, stop_sequence: null }, usage: { output_tokens: 50 } }) },
  { type: "message_stop", raw: JSON.stringify({ type: "message_stop" }) },
]
const body = { upstream: { sseEvents: frames }, format: "anthropic", stream: true, stopAfter: "rewrite-out" }
const res = await fetch("http://localhost:4141/api/debug/dry-run-pipeline", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer copilot-api" }, body: JSON.stringify(body) })
console.log("HTTP", res.status)
const json = await res.json()
console.log(JSON.stringify(json, null, 2))

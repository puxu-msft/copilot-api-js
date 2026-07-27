/**
 * Replay the CLIENT payload of the remote 400 (`req_1785160010003_3754`, prefill wording =
 * C3) through the CURRENT sanitize pipeline and print the resulting assistant-message
 * layouts, so we can tell whether master still manufactures the illegal
 * `[thinking, tool_use, thinking]` shape the remote instance sent.
 *
 * Usage: bun run exp/thinking-terminal-block/probe-remote-c3-regression.ts <entry.json>
 */
import type { MessageParam, MessagesPayload } from "~/types/api/anthropic"

import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"

const shape = (m: MessageParam): string =>
  Array.isArray(m.content) ? m.content.map((b) => (typeof b === "string" ? "str" : b.type)).join(",") : "TEXT"

const src = process.argv[2] ?? "/tmp/prefill-400/entry.json"
const entry = (await Bun.file(src).json()) as {
  clientRequest: { body: MessagesPayload }
  attempts: Array<{ upstreamRequest: { body: MessagesPayload } }>
}

const clientBody = entry.clientRequest.body
const sentUpstream = entry.attempts[0].upstreamRequest.body

const out = sanitizeAnthropicMessages(clientBody)

const label = (m: MessageParam): string => `${m.role}: ${shape(m)}`
console.log("=== client msg[36] ===", label(clientBody.messages[36]))
console.log("=== remote sent      ===", label(sentUpstream.messages[36]))
console.log("=== master produces  ===", label(out.payload.messages[36]))
console.log("=== block-layout stats ===", JSON.stringify(out.stats.blockLayout))
// The layout can look right while the stats wiring is broken — say so loudly instead of
// printing `undefined` and leaving the reader to assume the pass ran.
if (out.stats.blockLayout === undefined || out.stats.blockLayout.repairedMessages === 0) {
  console.log("  !! no repair recorded — either this payload needed none, or the stats wiring is broken")
}

// Full audit: every assistant message must satisfy C1 (no adjacent thinking),
// C2 (does not end on thinking) and C3 (a message with tool_use ends on tool_use).
const isThinking = (t: string): boolean => t === "thinking" || t === "redacted_thinking"
let violations = 0
for (const [i, m] of out.payload.messages.entries()) {
  if (m.role !== "assistant" || !Array.isArray(m.content)) continue
  const types = m.content.map((b) => (typeof b === "string" ? "str" : b.type))
  const c1 = types.some((t, j) => j > 0 && isThinking(t) && isThinking(types[j - 1]))
  const c2 = types.length > 0 && isThinking(types.at(-1) as string)
  const c3 = types.includes("tool_use") && types.at(-1) !== "tool_use"
  if (c1 || c2 || c3) {
    violations++
    console.log(`  VIOLATION [${i}] ${types.join(",")} → ${[c1 && "C1", c2 && "C2", c3 && "C3"].filter(Boolean).join("+")}`)
  }
}
console.log(violations === 0 ? "ALL assistant messages satisfy C1+C2+C3" : `${violations} violating message(s)`)

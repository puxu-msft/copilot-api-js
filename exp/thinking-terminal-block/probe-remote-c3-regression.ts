/**
 * Replay the CLIENT payload of an exported history entry through the CURRENT sanitize pipeline and compare three legs — what the client sent, what the instance that took the 400 actually put on the wire, and what master produces today — so we can tell whether master still manufactures an illegal thinking layout, or whether the 400 came from a STALE build that predates the fix.
 *
 * Violating messages are located BY SHAPE, never by a hard-coded index: upstream's own `messages.N` index is unreliable (spec 推论 3) and every entry violates at a different spot.
 *
 * EVERY attempt is scanned, not just `attempts[0]`: an entry can hold a retry ladder, and the leg upstream finally rejected is not necessarily the first one. Picking one attempt silently produces a false negative ("violates NONE") on exactly the entries that need this probe most.
 *
 * Usage: bun run exp/thinking-terminal-block/probe-remote-c3-regression.ts <entry.json>
 *   (export from the History UI is `.json.zst` — `zstd -d` it first)
 */
import type { MessageParam, MessagesPayload } from "~/types/api/anthropic"

import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"

interface Entry {
  id?: string
  state?: string
  process?: { pid?: number; bootTime?: number; version?: string; gitSha?: string; gitDirty?: boolean }
  clientRequest: { body: MessagesPayload }
  clientResponse?: { status?: number; body?: unknown }
  attempts?: Array<{
    index?: number
    error?: string
    upstreamRequest?: { body?: MessagesPayload }
    upstreamResponse?: { status?: number }
  }>
}

const blockTypes = (m: MessageParam): Array<string> =>
  Array.isArray(m.content) ? m.content.map((b) => (typeof b === "string" ? "str" : b.type)) : ["TEXT"]

const shape = (m: MessageParam | undefined): string => (m === undefined ? "—" : `${m.role}: ${blockTypes(m).join(",")}`)

const isThinking = (t: string): boolean => t === "thinking" || t === "redacted_thinking"

/** The three empirically pinned upstream constraints (spec §2). Returns the violated ones. */
function violations(m: MessageParam): Array<string> {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return []
  const types = blockTypes(m)
  const out: Array<string> = []
  if (types.some((t, j) => j > 0 && isThinking(t) && isThinking(types[j - 1]))) out.push("C1")
  if (types.length > 0 && isThinking(types.at(-1) as string)) out.push("C2")
  if (types.includes("tool_use") && types.at(-1) !== "tool_use") out.push("C3")
  return out
}

/** Indices of every message violating at least one constraint. */
const violatingIndices = (messages: Array<MessageParam>): Array<number> =>
  messages.flatMap((m, i) => (violations(m).length > 0 ? [i] : []))

const src = process.argv[2]
if (src === undefined) {
  console.error("usage: bun run exp/thinking-terminal-block/probe-remote-c3-regression.ts <entry.json>")
  process.exit(2)
}
const entry = (await Bun.file(src).json()) as Entry

const clientBody = entry.clientRequest.body
const out = sanitizeAnthropicMessages(clientBody)

// WHICH BUILD produced the wire we are judging. A 400 whose shape master no longer produces means nothing until you know the failing instance was NOT running master — that is the single fact this probe exists to surface first.
// `gitSha` absent does NOT prove "packaged install": initProcessIdentity folds EVERY git failure (git missing, cwd outside the checkout, permissions, `safe.directory`, 2s timeout) into an omitted field, so all we can honestly report is that the identity was never captured.
const p = entry.process
console.log(`entry ${entry.id ?? "?"}  state=${entry.state ?? "?"}  status=${entry.clientResponse?.status ?? "?"}`)
console.log(
  `served by: pid=${p?.pid ?? "?"} version=${p?.version ?? "?"} gitSha=${p?.gitSha ?? "(git identity unavailable — packaged install, or the git lookup failed)"}`
    + ` booted=${p?.bootTime === undefined ? "?" : new Date(p.bootTime).toISOString()}`,
)

const attempts = entry.attempts ?? []
if (attempts.length === 0) {
  console.error("\n!! this entry has no attempts — nothing ever reached upstream, so there is no wire leg to judge")
  process.exit(1)
}

// Locate the violation by SHAPE, on every leg that actually reached upstream.
let totalWireViolations = 0
for (const [ai, attempt] of attempts.entries()) {
  const sent = attempt.upstreamRequest?.body?.messages
  const header = `--- attempt ${attempt.index ?? ai}  upstreamStatus=${attempt.upstreamResponse?.status ?? "?"}  error=${attempt.error ?? "none"} ---`
  if (sent === undefined) {
    console.log(`\n${header}\n  (no upstreamRequest recorded — nothing to judge on this attempt)`)
    continue
  }
  const indicesAlign = sent.length === clientBody.messages.length && sent.length === out.payload.messages.length
  const found = violatingIndices(sent)
  totalWireViolations += found.length
  console.log(`\n${header}`)
  if (found.length === 0) console.log("  no C1/C2/C3 violation on this attempt's wire")
  for (const i of found) {
    console.log(`  violating message [${i}] → ${violations(sent[i]).join("+")}`)
    console.log(`    client sent     : ${shape(indicesAlign ? clientBody.messages[i] : undefined)}`)
    console.log(`    attempt sent    : ${shape(sent[i])}`)
    console.log(`    master produces : ${shape(indicesAlign ? out.payload.messages[i] : undefined)}`)
  }
  if (!indicesAlign) {
    console.log(
      `  (client/attempt/master message counts differ: ${clientBody.messages.length}/${sent.length}/${out.payload.messages.length}`
        + " — per-index comparison suppressed, the shapes above are the wire leg only)",
    )
  }
}
if (totalWireViolations === 0) {
  console.log(`\n!! none of the ${attempts.length} attempt(s) violates C1/C2/C3 on the wire — this failure came from something else`)
}

console.log("\n=== block-layout stats (master) ===", JSON.stringify(out.stats.blockLayout))
// The layout can look right while the stats wiring is broken — say so loudly instead of printing `undefined` and leaving the reader to assume the pass ran.
if (out.stats.blockLayout === undefined || out.stats.blockLayout.repairedMessages === 0) {
  console.log("  !! no repair recorded — either this payload needed none, or the stats wiring is broken")
}

// Full audit of what master would put on the wire today. Only assistant messages can violate, but every message is walked so the count below is the whole conversation.
let count = 0
for (const [i, m] of out.payload.messages.entries()) {
  const v = violations(m)
  if (v.length > 0) {
    count++
    console.log(`  VIOLATION [${i}] ${blockTypes(m).join(",")} → ${v.join("+")}`)
  }
}
const assistantCount = out.payload.messages.filter((m) => m.role === "assistant").length
console.log(
  count === 0 ?
    `\nALL ${out.payload.messages.length} messages (${assistantCount} assistant) satisfy C1+C2+C3 under master`
  : `\n${count} violating message(s) under master`,
)

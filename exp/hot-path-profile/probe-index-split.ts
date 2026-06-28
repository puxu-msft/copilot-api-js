/** Probe②: split the 56ms buildSearchIndex into buildInboundMsgs (per-message,
 * chunkable) vs buildAux SSE-frame diff (monolithic jsdiff). Decides Stage 2 shape. */
import { readFileSync } from "node:fs"
import { alignWithModified } from "~/lib/diff/block-align"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"
import { hashMessage, normalizeMessageForIndex } from "~/lib/history/normalize-message"

const DIR = import.meta.dirname
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
const fmt = "anthropic" as never
const msgs = entry.inboundRequest?.messages ?? []
const up = entry.sseEvents ?? []
const fwd = entry.inboundResponse?.sseEvents ?? []

const time = (label: string, fn: () => void, reps = 20) => {
  for (let i=0;i<3;i++) fn()
  const t = Bun.nanoseconds(); for (let i=0;i<reps;i++) fn()
  const ms = (Bun.nanoseconds()-t)/1e6/reps
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(2)} ms`); return ms
}
console.log(`entry: ${msgs.length} inbound messages, ${up.length} upstream frames, ${fwd.length} forwarded frames`)
const whole = time("buildSearchIndexForEntry (whole)", () => void buildSearchIndexForEntry(entry))
const inbound = time("buildInboundMsgs (per-message map — CHUNKABLE)", () => { for (let p=0;p<msgs.length;p++){ hashMessage(msgs[p],fmt); normalizeMessageForIndex(msgs[p],fmt) } })
const diff = time("alignWithModified SSE frames (jsdiff — MONOLITHIC)", () => void alignWithModified(up, fwd, (f:never)=> (f as {raw?:string}).raw ?? "", (f:never)=> (f as {type?:string}).type ?? ""))
console.log(`\nsplit: inbound-msgs ${(100*inbound/whole).toFixed(0)}%  |  SSE-diff ${(100*diff/whole).toFixed(0)}%  |  rest ${(100*(whole-inbound-diff)/whole).toFixed(0)}%`)

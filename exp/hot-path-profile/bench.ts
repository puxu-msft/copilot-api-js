/**
 * Hot-path profiling harness (empirical-verification of the static read).
 *
 * Does NOT start a server. Drives the REAL per-frame response chain the driver
 * runs (driver.ts:387-411 — onUpstreamFrame accumulate → assembled S5 rewrites'
 * transform → sink forwarded-sampling frameType) over a REAL 1977-frame opus-4.8
 * stream pulled from the running history API (req_1782616715522_803), calling the
 * REAL functions (accumulateAnthropicStreamEvent, ANTHROPIC_RESPONSE_REWRITES via
 * assembleResponseRewrites, the real compression/structuredClone) under DEFAULT config.
 *
 * Measures:
 *   A. per-frame JSON.parse multiplicity + wall time, vs a parse-once (memoized) variant
 *   B. zstdCompressSync wall time on real payloads (event-loop block per request)
 *   C. structuredClone wall time on the real 504KB inbound request
 */
import { readFileSync } from "node:fs"

import { accumulateAnthropicStreamEvent, createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { ANTHROPIC_RESPONSE_REWRITES } from "~/lib/codec/anthropic/response-rewrite-adapters"
import { compress } from "~/lib/history/sqlite/compression"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"
import { partitionStagesForWrite, serializeHeadEntry } from "~/lib/history/sqlite/serialize"
import { assembleResponseRewrites, type ResponseRewrite, type RewriteState } from "~/lib/pipeline/rewrite-registry"
import { createToolNameMapper } from "~/lib/tool-name-mapper"

const DIR = import.meta.dirname
const frames: Array<{ type: string; data: string }> = JSON.parse(readFileSync(`${DIR}/frames-803.json`, "utf8"))
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
const inboundRequest = entry.inboundRequest ?? {}

// ── JSON.parse instrumentation ──────────────────────────────────────────────
const realParse = JSON.parse
let parseCount = 0
function countingParse(this: unknown, ...args: Parameters<typeof realParse>) {
  parseCount++
  return realParse.apply(this, args as never)
}

// ── env / ctx stub (only what the default-on rewrites' createState reads) ─────
const ctxStub = {
  toolNameMapper: createToolNameMapper((inboundRequest.tools ?? []).map((t: { name: string }) => t.name), { allowDots: false, maxNameLength: 64 }),
  recordFeature: () => {},
} as never
const env = { clientFormat: "anthropic", body: inboundRequest, ctx: ctxStub } as never

const rewrites: Array<ResponseRewrite> = assembleResponseRewrites(env, ANTHROPIC_RESPONSE_REWRITES)
console.log(`[setup] frames=${frames.length}  active rewrites=[${rewrites.map((r) => r.name).join(", ")}]`)

// Faithful copy of client-sink.ts frameType (the forwarded-track sampler, run per frame).
function frameType(data: string | undefined, event?: string): string {
  if (data) {
    try {
      const parsed = JSON.parse(data) as { type?: unknown }
      if (typeof parsed.type === "string") return parsed.type
    } catch {
      /* fall through */
    }
  }
  return event ?? (data ? "message" : "keepalive")
}

// One faithful pass = the driver's per-frame loop for Anthropic (renderFrames = identity).
function runOnePass(useCount: boolean): number {
  const acc = createAnthropicStreamAccumulator()
  const states: Array<RewriteState> = rewrites.map((r) => r.createState?.(env) ?? {})
  let sunkType = ""
  for (const frame of frames) {
    // onUpstreamFrame — accumulate on the raw upstream frame
    try {
      acc.sawMessageStop // touch to keep acc live
      accumulateAnthropicStreamEvent(JSON.parse(frame.data), acc)
    } catch {
      /* keepalive / unparseable */
    }
    // S5 — passThrough: each rewrite.transform(frame, state)
    let current: Array<{ data?: string; event?: string }> = [frame]
    for (let i = 0; i < rewrites.length; i++) {
      const next: Array<{ data?: string; event?: string }> = []
      for (const f of current) {
        const action = rewrites[i].transform(f as never, states[i])
        if (action.kind === "emit") next.push(...(action.frames as never[]))
      }
      current = next
    }
    // sink — forwarded sampling (frameType) per surviving frame
    for (const f of current) sunkType = frameType(f.data, f.event)
  }
  void sunkType
  void useCount
  return acc.outputTokens ?? 0
}

// ── A. per-frame parse multiplicity + time ───────────────────────────────────
function benchA(): void {
  // parse count for ONE pass
  globalThis.JSON.parse = countingParse as never
  parseCount = 0
  runOnePass(true)
  globalThis.JSON.parse = realParse
  const perFrame = parseCount / frames.length
  console.log(`\n[A] JSON.parse calls for 1 pass: ${parseCount}  (= ${perFrame.toFixed(2)} per frame over ${frames.length} frames)`)

  // wall time — current chain
  const REPS = 200
  for (let i = 0; i < 5; i++) runOnePass(false) // warmup
  let t = Bun.nanoseconds()
  for (let i = 0; i < REPS; i++) runOnePass(false)
  const curMs = (Bun.nanoseconds() - t) / 1e6 / REPS
  console.log(`[A] current per-frame chain: ${curMs.toFixed(3)} ms / full ${frames.length}-frame stream  (${((curMs * 1000) / frames.length).toFixed(2)} µs/frame)`)

  // parse-once variant: memoize JSON.parse by identity of the data string within a pass
  const memoParseFactory = () => {
    const cache = new Map<string, unknown>()
    return (s: string) => {
      if (cache.has(s)) return cache.get(s)
      const v = realParse(s)
      cache.set(s, v)
      return v
    }
  }
  function runMemoPass(): void {
    const memo = memoParseFactory()
    globalThis.JSON.parse = ((s: string) => memo(s)) as never
    runOnePass(false)
    globalThis.JSON.parse = realParse
  }
  for (let i = 0; i < 5; i++) runMemoPass()
  t = Bun.nanoseconds()
  for (let i = 0; i < REPS; i++) runMemoPass()
  const memoMs = (Bun.nanoseconds() - t) / 1e6 / REPS
  console.log(`[A] parse-once (memoized) variant:  ${memoMs.toFixed(3)} ms / stream  → delta ${(curMs - memoMs).toFixed(3)} ms (${(((curMs - memoMs) / curMs) * 100).toFixed(1)}% of chain)`)
}

// ── B. zstd sync compression (event-loop block per request finalize) ──────────
function benchB(): void {
  const payloads: Array<[string, unknown]> = [
    ["inboundRequest (504KB req)", inboundRequest],
    ["effectiveRequest", entry.effectiveRequest ?? {}],
    ["sseEvents (1977 frames, 207KB)", entry.sseEvents ?? []],
    ["outboundResponse", entry.outboundResponse ?? {}],
  ]
  console.log(`\n[B] zstdCompressSync wall time (synchronous — blocks the event loop):`)
  let totalMs = 0
  for (const [label, p] of payloads) {
    const json = JSON.stringify(p)
    const REPS = 50
    for (let i = 0; i < 3; i++) compress(p)
    const t = Bun.nanoseconds()
    for (let i = 0; i < REPS; i++) compress(p)
    const ms = (Bun.nanoseconds() - t) / 1e6 / REPS
    totalMs += ms
    console.log(`    ${label.padEnd(34)} ${(json.length / 1024).toFixed(0).padStart(5)} KB → ${ms.toFixed(2)} ms`)
  }
  console.log(`    ${"≈ total sync block / request finalize".padEnd(34)} ${" ".repeat(8)} ${totalMs.toFixed(2)} ms`)
}

// ── B'. REAL finalize sequence (insertCompletedEntry hot path) ────────────────
// Faithful to write.ts:insertCompletedEntry: buildSearchIndex (CPU, pre-tx) +
// compress(head) + compress(combined request_group ~6MB) + compress(each response
// stage) — ALL synchronous on the single event-loop thread, the tx holding the
// SQLite write lock throughout.
function benchFinalize(): void {
  const time = (label: string, fn: () => void, reps = 30): number => {
    for (let i = 0; i < 3; i++) fn()
    const t = Bun.nanoseconds()
    for (let i = 0; i < reps; i++) fn()
    const ms = (Bun.nanoseconds() - t) / 1e6 / reps
    console.log(`    ${label.padEnd(40)} ${ms.toFixed(2)} ms`)
    return ms
  }
  console.log(`\n[B'] REAL per-request finalize sync block (insertCompletedEntry):`)
  const { stages } = serializeHeadEntry(entry)
  const { groupRow, rest } = partitionStagesForWrite(stages)
  let total = 0
  total += time("buildSearchIndexForEntry (CPU, pre-tx)", () => void buildSearchIndexForEntry(entry))
  total += time("compress(head)", () => void compress(serializeHeadEntry(entry).row))
  if (groupRow) total += time("compress(request_group, combined ~6MB)", () => void compress(groupRow.payload))
  for (const s of rest) total += time(`compress(${s.stage})`, () => void compress(s.payload))
  console.log(`    ${"━".repeat(40)}`)
  console.log(`    ${"≈ total synchronous event-loop block".padEnd(40)} ${total.toFixed(2)} ms`)
}


function benchC(): void {
  const REPS = 200
  const reqJson = JSON.stringify(inboundRequest)
  for (let i = 0; i < 5; i++) structuredClone(inboundRequest)
  const t = Bun.nanoseconds()
  for (let i = 0; i < REPS; i++) structuredClone(inboundRequest)
  const ms = (Bun.nanoseconds() - t) / 1e6 / REPS
  console.log(`\n[C] structuredClone(inboundRequest): ${(reqJson.length / 1024).toFixed(0)} KB → ${ms.toFixed(3)} ms / request`)
}

benchA()
benchB()
benchFinalize()
benchC()

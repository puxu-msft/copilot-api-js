/**
 * Reproducible baseline for the native history `list-search` read path.
 *
 * Measures wall time of `listSearch` against a synthetic corpus at several sizes, for the
 * query shapes the History list UI actually issues. It exists to keep a performance claim
 * about that path anchored to a measurement instead of to reasoning about the code.
 *
 * Run:
 *   bun run build:history-search
 *   bun run exp/history-search-list-perf/bench.ts            # default sizes
 *   bun run exp/history-search-list-perf/bench.ts 2000 20000 # explicit sizes
 *
 * The corpus is built once per size into a fresh temp directory and deleted afterwards.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  getNativeHistorySearch,
  type NativeHistoryIndex,
  type NativeHistoryListSearchRequest,
} from "../../src/lib/history/search-native"

const ENDPOINTS = ["anthropic-messages", "openai-chat-completions", "openai-responses", "gemini-generate-content"]
const STATES = ["completed", "failed", "aborted", "interrupted", "streaming"]
const MODELS = ["claude-sonnet-4", "claude-opus-4", "gpt-5", "gemini-2.5-pro"]
const SESSION_COUNT = 100

/** Deterministic pseudo-random so two runs measure the same corpus. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_00_00_00_00
  }
}

/**
 * Content with a rare token in ~1% of documents and a common token in ~50%, so the same
 * corpus can exercise both a highly selective and a broad full-text query.
 */
function content(index: number, random: () => number): string {
  const words = [
    "streaming",
    "upstream",
    "anthropic",
    "completion",
    "tool_use",
    "signature",
    "cancelled",
    "retry",
    "keepalive",
    "translated",
  ]
  const body = Array.from({ length: 40 }, () => words[Math.floor(random() * words.length)]).join(" ")
  const common = index % 2 === 0 ? " frequenttoken" : ""
  const rare = index % 100 === 0 ? " raretoken" : ""
  return `operation ${index} ${body}${common}${rare}`
}

async function buildCorpus(index: NativeHistoryIndex, size: number): Promise<void> {
  const random = makeRandom(0x5eed)
  const base = Date.UTC(2026, 0, 1)
  for (let i = 0; i < size; i++) {
    await index.upsertSummary({
      operationId: `op-${String(i).padStart(8, "0")}`,
      operationKind: i % 7 === 0 ? "count_tokens" : "generation",
      createdAt: base + i * 1000,
      committedAt: base + i * 1000,
      content: content(i, random),
      endpoint: ENDPOINTS[i % ENDPOINTS.length],
      state: STATES[i % STATES.length],
      pid: 1000 + (i % 17),
      sessionId: `session-${i % SESSION_COUNT}`,
      agentId: i % 5 === 0 ? `agent-${i % 11}` : undefined,
      requestModel: MODELS[i % MODELS.length],
      responseModel: MODELS[(i + 1) % MODELS.length],
    })
  }
  await index.flush()
}

interface Scenario {
  name: string
  request: Omit<NativeHistoryListSearchRequest, "targetCommittedAt" | "targetOperationIds">
}

const BASE = {
  operationKinds: [] as Array<string>,
  states: [] as Array<string>,
  direction: "older" as const,
  limit: 50,
}

const SCENARIOS: Array<Scenario> = [
  { name: "list, no filter", request: { ...BASE, query: "" } },
  { name: "list, session filter (1%)", request: { ...BASE, query: "", sessionId: "session-7" } },
  { name: "list, state+endpoint filter", request: { ...BASE, query: "", states: ["completed"], endpoint: ENDPOINTS[0] } },
  { name: "list, model substring", request: { ...BASE, query: "", model: "opus" } },
  { name: "search, broad term (50%)", request: { ...BASE, query: "frequenttoken" } },
  { name: "search, rare term (1%)", request: { ...BASE, query: "raretoken" } },
  { name: "search + session filter", request: { ...BASE, query: "frequenttoken", sessionId: "session-7" } },
]

function median(values: Array<number>): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure(index: NativeHistoryIndex, scenario: Scenario, rounds: number): Promise<{ ms: number; total: number }> {
  const request: NativeHistoryListSearchRequest = {
    ...scenario.request,
    targetCommittedAt: Number.MAX_SAFE_INTEGER,
    targetOperationIds: [],
  }
  let total = 0
  const samples: Array<number> = []
  for (let round = 0; round < rounds; round++) {
    const started = performance.now()
    const result = await index.listSearch(request)
    samples.push(performance.now() - started)
    total = result.total
  }
  return { ms: median(samples), total }
}

async function main(): Promise<void> {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean)
  const corpusSizes = sizes.length > 0 ? sizes : [2000, 20_000, 100_000]
  const rounds = 7
  const { HistoryIndex } = await getNativeHistorySearch()

  for (const size of corpusSizes) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "history-search-bench-"))
    const index = new HistoryIndex(directory)
    const buildStarted = performance.now()
    await buildCorpus(index, size)
    const buildMs = performance.now() - buildStarted
    console.log(`\ncorpus ${size} docs (build ${buildMs.toFixed(0)} ms)`)
    console.log("| scenario | median ms | total |")
    console.log("|---|---:|---:|")
    for (const scenario of SCENARIOS) {
      const { ms, total } = await measure(index, scenario, rounds)
      console.log(`| ${scenario.name} | ${ms.toFixed(1)} | ${total} |`)
    }
    await index.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}

await main()

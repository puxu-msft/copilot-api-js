/**
 * The overlay answers for rows the index has not indexed yet, so the two must agree — and this test
 * exists because describing that agreement in a comment failed four times running. Each description
 * was plausible and each was wrong about a detail of a tokenizer nobody here wrote, so the real index
 * is the oracle instead.
 *
 * BOTH directions are checked. The under-match direction hides a just-finished request until the
 * sidecar catches up. The over-match direction was assumed harmless for three rounds and is not:
 * overlay rows are the newest, so an over-matching predicate puts unrelated rows at the top of the
 * first page, inflates `total`, and hands out cursors for rows that do not belong to the result.
 *
 * The single exemption is a one-word needle, which stays a substring test on purpose so a search box
 * responds as you type. It is listed per pair rather than granted wholesale.
 */
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { HistoryEntry } from "~/lib/history/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  clearInFlight,
  putInFlight,
} from "~/lib/history/in-flight"
import { listHistoryOverlaySummaries } from "~/lib/history/queries"
import {
  //
  getNativeHistorySearch,
  isNativeHistorySearchAvailable,
} from "~/lib/history/search-native"
import { projectSearchableText } from "~/lib/history/v3/projection"
import {
  //
  publishModelOperationTerminal,
  resetModelOperationTerminalBusForTests,
} from "~/lib/history/v3/terminal-bus"

import { historyTerminalPublication } from "../../helpers/history-terminal-publication"

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  clearInFlight()
  resetModelOperationTerminalBusForTests()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function liveEntry(content: string): HistoryEntry {
  return {
    id: "overlay-row",
    operationKind: "generation",
    startedAt: 100,
    endpoint: "anthropic-messages",
    state: "streaming",
    active: true,
    clientRequest: { model: "m", messages: [{ role: "user", content }] },
    clientResponse: {},
    attempts: [],
    model: {},
  }
}

/** A terminal record on the recent bus, whose searchable corpus is the JSON production indexes. */
function recentRecord(content: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: "overlay-row", kind: "generation", createdAt: 100 } })
  const payload = recorder.registerPayload({ messages: [{ role: "user", content }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  return recorder.commitTerminal({ outcome: "completed" })
}

interface Pair {
  content: string
  needle: string
}

/**
 * Whether a needle is one term, derived by the same split the predicate uses rather than annotated
 * by hand — a mis-annotated pair would silently grant itself the over-match exemption.
 */
function isSingleTerm(needle: string): boolean {
  return (
    needle
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean).length <= 1
  )
}

/**
 * Pairs span the ways two tokenizers drift: punctuation inside a word, a term the row lacks,
 * non-Latin scripts, digits, the id- and key-dense JSON that `projectSearchableText` actually
 * produces (where a substring test goes wrong), and the length at which the index stops indexing a
 * token at all.
 */
const PAIRS: Array<Pair> = [
  { content: "please fix the hello-world bug", needle: "hello world" },
  { content: "please fix the hello-world bug", needle: "fix the parser bug" },
  { content: "please fix the hello-world bug", needle: "hello zzzabsent" },
  { content: "please fix the hello-world bug", needle: "zzzabsent qqqabsent" },
  { content: "retry after a 429 response", needle: "429 rate limit" },
  { content: "你好，世界", needle: "你好 世界" },
  { content: "修复 错误 in the parser", needle: "错误 timeout" },
  { content: "значение по умолчанию", needle: "значение умолчанию" },
  { content: "Grüße aus München", needle: "grüße münchen" },
  { content: "config.yaml was reloaded", needle: "config yaml" },
  // Short terms against id-dense text: `429` sits inside the request id, `it` inside `waiting`.
  { content: "commit the editor change, request id 5f1429ab, waiting for upstream", needle: "429 error" },
  { content: "commit the editor change, request id 5f1429ab, waiting for upstream", needle: "fix it" },
  { content: "commit the editor change, request id 5f1429ab, waiting for upstream", needle: "a bug" },
  { content: "commit the editor change, request id 5f1429ab, waiting for upstream", needle: "commit editor" },
  // The index drops tokens of 40 bytes or more (`RemoveLongFilter`), so the boundary is a real
  // agreement axis: 39 is searchable, 40 is not, and a digest never is.
  { content: `id ${"a".repeat(39)} done`, needle: `${"a".repeat(39)} zzzabsent` },
  { content: `id ${"a".repeat(40)} done`, needle: `${"a".repeat(40)} zzzabsent` },
  { content: `digest ${"9f".repeat(32)} recorded`, needle: `${"9f".repeat(32)} zzzabsent` },
  // Single-term needles: substring by design. Kept in the table so the exemption is exercised, not
  // assumed — `isSingleTerm` decides which they are.
  { content: "please fix the hello-world bug", needle: "orld" },
  { content: "commit the editor change, request id 5f1429ab, waiting for upstream", needle: "429" },
]

async function indexSaysMatch(needle: string, corpusForIndex: string): Promise<boolean> {
  const { HistoryIndex } = await getNativeHistorySearch()
  const index = new HistoryIndex(path.join(freshDir("overlay-agreement-"), "index"))
  await index.upsertSummary({
    operationId: "overlay-row",
    operationKind: "generation",
    createdAt: 100,
    committedAt: 5,
    content: corpusForIndex,
    sessionId: "s",
  })
  await index.flush()
  const matched =
    (
      await index.listSearch({
        query: needle,
        operationKinds: [],
        states: [],
        targetCommittedAt: 10,
        targetOperationIds: [],
        direction: "older",
        limit: 10,
      })
    ).total > 0
  await index.close()
  return matched
}

describe.skipIf(!isNativeHistorySearchAvailable())("overlay and index agree in both directions", () => {
  /**
   * The in-flight lane: a live entry has only its inbound messages, so the index is fed the same
   * text the overlay normalizes.
   */
  test("in-flight rows match the index, and only the index", async () => {
    const disagreements: Array<string> = []
    for (const { content, needle } of PAIRS) {
      const indexed = await indexSaysMatch(needle, content)
      clearInFlight()
      putInFlight(liveEntry(content))
      const overlay = listHistoryOverlaySummaries(needle).length > 0
      if (indexed && !overlay) disagreements.push(`hidden: ${JSON.stringify(content)} / ${JSON.stringify(needle)}`)
      if (!indexed && overlay && !isSingleTerm(needle)) disagreements.push(`over-matched: ${JSON.stringify(content)} / ${JSON.stringify(needle)}`)
    }
    expect(disagreements).toEqual([])
    // Builds one real Tantivy index per pair, so the run time tracks the machine rather than the
    // behaviour under test. The explicit budget keeps a loaded shard from reporting a timeout where
    // the assertion would have passed — the very failure mode recorded in the deferred backlog.
  }, 120_000)

  /**
   * The recent-bus lane, which is the one that matters most: its corpus is `projectSearchableText`
   * — the exact JSON the sidecar will index — so this is where a substring test meets keys, quotes
   * and request ids. It had no coverage at all until a reviewer pointed that out.
   */
  test("recent terminal rows match the index over the JSON corpus it will actually hold", async () => {
    const disagreements: Array<string> = []
    for (const { content, needle } of PAIRS) {
      const record = recentRecord(content)
      const indexed = await indexSaysMatch(needle, projectSearchableText(record))
      resetModelOperationTerminalBusForTests()
      publishModelOperationTerminal(historyTerminalPublication(record))
      const overlay = listHistoryOverlaySummaries(needle).length > 0
      if (indexed && !overlay) disagreements.push(`hidden: ${JSON.stringify(needle)}`)
      if (!indexed && overlay && !isSingleTerm(needle)) disagreements.push(`over-matched: ${JSON.stringify(needle)}`)
    }
    expect(disagreements).toEqual([])
  }, 120_000)

  test("a needle sharing nothing with the row still matches nothing", () => {
    putInFlight(liveEntry("please fix the hello-world bug"))
    expect(listHistoryOverlaySummaries("zzzabsent qqqabsent")).toEqual([])
    expect(listHistoryOverlaySummaries("hello")).toHaveLength(1)
  })
})

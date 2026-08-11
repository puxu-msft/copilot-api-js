/**
 * Round-4 probe: where does the hand-written overlay tokenizer still disagree with Tantivy's?
 *
 * The overlay is the ONLY way to see a row the index has not indexed yet, so a miss here is a
 * user-visible hole rather than a cosmetic difference. Non-ASCII input is the obvious suspect: the
 * overlay splits on /[^a-z0-9]+/, which treats every CJK character as a separator.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

/** The production overlay predicate, copied verbatim from `queries.ts` so the probe tests IT. */
function corpusMatchesSearch(text: string, needle: string | undefined): boolean {
  if (!needle) return true
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  const tokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean))
  return terms.every((term) => tokens.has(term))
}

const CASES: Array<[corpus: string, needle: string]> = [
  ["请修复 hello-world 的缺陷", "hello world"],
  ["请修复缓存穿透的缺陷", "缓存 穿透"],
  ["请修复缓存穿透的缺陷", "缓存穿透"],
  ["retry_after was 30 seconds", "retry_after"],
  ["retry_after was 30 seconds", "retry after"],
  ["HTTP 502 Bad Gateway", "http 502"],
  ["café serves crème brûlée", "café crème"],
  ["value is 3.14 exactly", "3 14"],
  ["MixedCase Identifier Here", "mixedcase identifier"],
  ["a/b/c path segments", "a b c"],
]

const directory = mkdtempSync(path.join(tmpdir(), "history-search-round4-probe-"))
const baseRequest: NativeHistoryListSearchRequest = {
  query: "",
  operationKinds: [],
  states: [],
  targetCommittedAt: 10,
  targetOperationIds: [],
  direction: "older",
  limit: 10,
}

try {
  const { HistoryIndex } = await getNativeHistorySearch()
  console.log("corpus                              needle             index  overlay  agree?")
  for (const [index_, [corpus, needle]] of CASES.entries()) {
    const cell = path.join(directory, `cell-${index_}`)
    const handle = new HistoryIndex(cell)
    await handle.upsertSummary({
      operationId: `op-${index_}`,
      operationKind: "generation",
      createdAt: 1,
      committedAt: 5,
      content: corpus,
      sessionId: "s-1",
    })
    await handle.flush()
    const indexed = (await handle.listSearch({ ...baseRequest, query: needle })).total > 0
    const overlay = corpusMatchesSearch(corpus, needle)
    console.log(
      `${corpus.padEnd(36)}${needle.padEnd(19)}${String(indexed).padEnd(7)}${String(overlay).padEnd(9)}${indexed === overlay ? "yes" : indexed ? "OVERLAY MISSES" : "overlay extra"}`,
    )
    await handle.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

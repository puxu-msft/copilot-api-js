/**
 * Round-5 probe: is Tantivy's QueryParser AND or OR by default, and does the overlay's `every`
 * therefore hide rows the index would return?
 *
 * The matcher below is copied VERBATIM from `queries.ts` so the probe tests the shipped predicate.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

/** Verbatim copy of the production predicate. */
function corpusMatchesSearch(text: string, needle: string | undefined): boolean {
  if (!needle) return true
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  const tokens = new Set(haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  return terms.every((term) => tokens.has(term))
}

/** Candidate fix: any term present, still substring-based so it only ever over-matches. */
function anyTermMatches(text: string, needle: string | undefined): boolean {
  if (!needle) return true
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  return terms.some((term) => haystack.includes(term))
}

const CASES: Array<[corpus: string, needle: string]> = [
  ["please fix the hello-world bug", "fix the parser bug"],
  ["please fix the hello-world bug", "hello zzzabsent"],
  ["please fix the hello-world bug", "hello absent"],
  ["retry after a 429 response", "429 rate limit"],
  ["修复 错误 in the parser", "错误 timeout"],
  ["please fix the hello-world bug", "bug zzzabsent qqqabsent"],
  ["please fix the hello-world bug", "zzzabsent1 zzzabsent2"],
  ["please fix the hello-world bug", "hello world"],
  ["你好，世界", "你好 世界"],
]

const directory = mkdtempSync(path.join(tmpdir(), "round5-probe-"))
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
  console.log("corpus                          needle                    index  every  some   verdict")
  for (const [index_, [corpus, needle]] of CASES.entries()) {
    const handle = new HistoryIndex(path.join(directory, `cell-${index_}`))
    await handle.upsertSummary({
      operationId: `op-${index_}`,
      operationKind: "generation",
      createdAt: 1,
      committedAt: 5,
      content: corpus,
      sessionId: "s",
    })
    await handle.flush()
    const indexed = (await handle.listSearch({ ...baseRequest, query: needle })).total > 0
    const every = corpusMatchesSearch(corpus, needle)
    const some = anyTermMatches(corpus, needle)
    const verdict = indexed && !every ? "EVERY HIDES" : indexed && !some ? "SOME HIDES" : "ok"
    console.log(
      `${corpus.padEnd(32)}${needle.padEnd(26)}${String(indexed).padEnd(7)}${String(every).padEnd(7)}${String(some).padEnd(7)}${verdict}`,
    )
    await handle.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

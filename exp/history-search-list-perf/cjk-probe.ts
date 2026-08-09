/**
 * Corrected CJK probe.
 *
 * An earlier version of this file concluded "CJK is entirely unsearchable in the index". That was
 * wrong, and the way it was wrong is worth keeping: it searched `缓存` against `请修复缓存穿透的缺陷`,
 * where Tantivy's `SimpleTokenizer` (Unicode `char::is_alphanumeric`) sees ONE token — an unbroken
 * run of CJK with no separator. A substring of a token is not that token, so of course it missed.
 * With punctuation to split on, CJK matches fine.
 *
 * What that leaves is the real defect: the overlay splits on /[^a-z0-9]+/, so a CJK needle produces
 * ZERO terms and falls through to a substring test against the raw needle — which fails wherever the
 * corpus punctuates differently from the query.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

/** Current production predicate (ASCII-only split). */
function asciiSplit(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  return terms.every((term) => new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean)).has(term))
}

/** Candidate: split on anything that is not a Unicode letter or number, like `SimpleTokenizer`. */
function unicodeSplit(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  return terms.every((term) => new Set(haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean)).has(term))
}

const CASES: Array<[corpus: string, needle: string]> = [
  ["你好，世界", "你好 世界"],
  ["请修复缓存穿透的缺陷", "缓存"],
  ["请修复、缓存穿透、的缺陷", "缓存穿透"],
  ["café serves crème brûlée", "café crème"],
  ["Grüße aus München", "grüße münchen"],
  ["значение по умолчанию", "значение умолчанию"],
  ["please fix the hello-world bug", "hello world"],
]

const directory = mkdtempSync(path.join(tmpdir(), "cjk-probe-"))
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
  console.log("corpus                          needle              index  ascii  unicode  verdict")
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
    const ascii = asciiSplit(corpus, needle)
    const unicode = unicodeSplit(corpus, needle)
    const verdict = indexed && !ascii ? "ASCII MISSES" : indexed === ascii ? "ascii ok" : "ascii extra"
    console.log(
      `${corpus.padEnd(32)}${needle.padEnd(20)}${String(indexed).padEnd(7)}${String(ascii).padEnd(7)}${String(unicode).padEnd(9)}${verdict}`,
    )
    await handle.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

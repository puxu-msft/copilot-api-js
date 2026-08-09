/**
 * Round-8 probe: does the byte limit cover the case that justified adding it?
 *
 * The argument for filtering long tokens was "searching a digest should not show recent rows that
 * then vanish". A user searching a digest pastes it alone — which takes the single-term branch.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

const INDEX_TOKEN_BYTE_LIMIT = 40

function indexableTokens(lowercased: string): Array<string> {
  return lowercased.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0 && Buffer.byteLength(token) < INDEX_TOKEN_BYTE_LIMIT)
}

/** The predicate BEFORE the sole-term guard (queries.ts @ 5a189ac8), kept for contrast. */
function before(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const rawTerms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (rawTerms.length <= 1) return haystack.includes(needle.toLowerCase())
  const tokens = new Set(indexableTokens(haystack))
  return rawTerms.filter((term) => Buffer.byteLength(term) < INDEX_TOKEN_BYTE_LIMIT).some((term) => tokens.has(term))
}

/** The predicate AFTER: a sole term the index cannot hold matches nothing. */
function after_(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const rawTerms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (rawTerms.length <= 1) {
    const sole = rawTerms[0]
    if (sole !== undefined && Buffer.byteLength(sole) >= INDEX_TOKEN_BYTE_LIMIT) return false
    return haystack.includes(needle.toLowerCase())
  }
  const tokens = new Set(indexableTokens(haystack))
  return rawTerms.filter((term) => Buffer.byteLength(term) < INDEX_TOKEN_BYTE_LIMIT).some((term) => tokens.has(term))
}

const DIGEST = "9f".repeat(32)
const CASES: Array<[label: string, corpus: string, needle: string]> = [
  ["single 64-hex digest", `digest ${DIGEST} recorded`, DIGEST],
  ["single 39-byte token", `id ${"a".repeat(39)} done`, "a".repeat(39)],
  ["single 40-byte token", `id ${"a".repeat(40)} done`, "a".repeat(40)],
  ["single short token (type-ahead)", "please fix the hello-world bug", "orld"],
  ["punctuation-only needle", "please fix the hello-world bug", "..."],
  ["two long needles", `digest ${DIGEST} recorded`, `${DIGEST} ${"ab".repeat(24)}`],
]

const directory = mkdtempSync(path.join(tmpdir(), "round8-probe-"))
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
  console.log("case                             index        before   after")
  for (const [index_, [label, corpus, needle]] of CASES.entries()) {
    const handle = new HistoryIndex(path.join(directory, `cell-${index_}`))
    await handle.upsertSummary({
      operationId: "op",
      operationKind: "generation",
      createdAt: 1,
      committedAt: 5,
      content: corpus,
      sessionId: "s",
    })
    await handle.flush()
    let indexed: string
    try {
      const result = await handle.listSearch({ ...baseRequest, query: needle })
      indexed = result.invalidQuery ? "INVALID" : String(result.total > 0)
    } catch (error) {
      indexed = `THROW ${(error as { code?: string }).code}`
    }
    console.log(`${label.padEnd(33)}${indexed.padEnd(13)}${String(before(corpus, needle)).padEnd(9)}${after_(corpus, needle)}`)
    await handle.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

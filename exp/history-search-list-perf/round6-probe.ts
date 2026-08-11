/**
 * Round-6 probe: how wide is `some + includes` on the corpus shape production actually stores?
 *
 * `projectSearchableText` emits JSON — keys, quotes, request ids, hashes — so a short term has far
 * more to collide with than in a bare sentence. The candidate fix is token equality, which is
 * exactly what the index does (OR of tokens).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

const CORPUS = JSON.stringify({
  messages: [{ role: "user", content: "commit the editor change, request id 5f1429ab, waiting for upstream" }],
})

/** Shipped predicate at cd80497a: OR of substrings. */
function someIncludes(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  return terms.some((term) => haystack.includes(term))
}

/** Candidate: OR of tokens — the index's own semantics. */
function someTokens(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  const tokens = new Set(haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  return terms.some((term) => tokens.has(term))
}

const NEEDLES = ["a bug", "fix it", "429 error", "e f", "commit editor", "no such thing", "upstream zzzabsent", "5f1429ab qqqabsent"]

const directory = mkdtempSync(path.join(tmpdir(), "round6-probe-"))
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
  const handle = new HistoryIndex(directory)
  await handle.upsertSummary({
    operationId: "op",
    operationKind: "generation",
    createdAt: 1,
    committedAt: 5,
    content: CORPUS,
    sessionId: "s",
  })
  await handle.flush()

  console.log(`corpus: ${CORPUS}\n`)
  console.log("needle                    index  some+includes  some+tokens  verdict")
  for (const needle of NEEDLES) {
    const indexed = (await handle.listSearch({ ...baseRequest, query: needle })).total > 0
    const wide = someIncludes(CORPUS, needle)
    const tokenwise = someTokens(CORPUS, needle)
    const verdict = indexed && !tokenwise ? "TOKENS HIDE" : indexed === tokenwise ? (indexed === wide ? "both ok" : "tokens fixes") : "tokens extra"
    console.log(`${needle.padEnd(26)}${String(indexed).padEnd(7)}${String(wide).padEnd(15)}${String(tokenwise).padEnd(13)}${verdict}`)
  }
  await handle.close()
} finally {
  rmSync(directory, { recursive: true, force: true })
}

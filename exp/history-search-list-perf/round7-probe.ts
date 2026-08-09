/**
 * Round-7 probe: where is the index's token length cutoff, and does the overlay disagree there?
 *
 * Tantivy's default tokenizer chain includes `RemoveLongFilter`, which drops tokens over a byte
 * limit. If the overlay keeps them, a long token in a multi-word needle matches here and not there —
 * the same over-match class just fixed at the short end.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

const INDEX_TOKEN_BYTE_LIMIT = 40

function tokensOf(text: string, applyLimit: boolean): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0 && (!applyLimit || Buffer.byteLength(token) < INDEX_TOKEN_BYTE_LIMIT)),
  )
}

function overlayMatches(text: string, needle: string, applyLimit: boolean): boolean {
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  const tokens = tokensOf(haystack, applyLimit)
  return terms.filter((term) => !applyLimit || Buffer.byteLength(term) < INDEX_TOKEN_BYTE_LIMIT).some((term) => tokens.has(term))
}

const directory = mkdtempSync(path.join(tmpdir(), "round7-probe-"))
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
  console.log("len  index(single)  index(multi)  overlay(no limit)  overlay(with limit)")
  for (const length of [38, 39, 40, 41, 42, 60]) {
    const token = "a".repeat(length)
    const corpus = JSON.stringify({ messages: [{ role: "user", content: `id ${token} done` }] })
    const handle = new HistoryIndex(path.join(directory, `cell-${length}`))
    await handle.upsertSummary({
      operationId: "op",
      operationKind: "generation",
      createdAt: 1,
      committedAt: 5,
      content: corpus,
      sessionId: "s",
    })
    await handle.flush()
    const single = (await handle.listSearch({ ...baseRequest, query: token })).total > 0
    const multi = (await handle.listSearch({ ...baseRequest, query: `${token} zzzabsent` })).total > 0
    console.log(
      `${String(length).padEnd(5)}${String(single).padEnd(15)}${String(multi).padEnd(14)}` +
        `${String(overlayMatches(corpus, `${token} zzzabsent`, false)).padEnd(19)}${overlayMatches(corpus, `${token} zzzabsent`, true)}`,
    )
    await handle.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

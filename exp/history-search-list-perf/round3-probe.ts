/**
 * Round-3 probe: does the overlay's substring test disagree with the index in BOTH directions?
 *
 * A comment now in the code claims the overlay only ever over-matches. If an ordinary multi-word
 * query hits the index and misses the overlay, that claim is false and the consequence is a
 * user-visible hole: a just-terminal row is the overlay's alone until the sidecar catches up.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

const CORPUS = "please fix the hello-world bug in src/lib/foo.ts"
const directory = mkdtempSync(path.join(tmpdir(), "history-search-round3-probe-"))
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
  const index = new HistoryIndex(directory)
  await index.upsertSummary({
    operationId: "op-a",
    operationKind: "generation",
    createdAt: 1,
    committedAt: 5,
    content: CORPUS,
    sessionId: "s-1",
  })
  await index.flush()

  console.log(`corpus: ${JSON.stringify(CORPUS)}\n`)
  console.log("needle              index  overlay(substring)  agree?")
  for (const needle of ["hello world", "src lib foo", "hello-world", "orld", "world", "hello"]) {
    const indexed = (await index.listSearch({ ...baseRequest, query: needle })).total > 0
    const overlay = CORPUS.toLowerCase().includes(needle.toLowerCase())
    console.log(`${JSON.stringify(needle).padEnd(20)}${String(indexed).padEnd(7)}${String(overlay).padEnd(20)}${indexed === overlay ? "yes" : "NO"}`)
  }
  await index.close()
} finally {
  rmSync(directory, { recursive: true, force: true })
}

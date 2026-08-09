/**
 * Round-2 probe: check two claims from the re-review before adopting them.
 *
 * 1. Is `code === "InvalidArg"` specific to a query the parser refuses, or does napi also use it
 *    for a malformed request (missing/mistyped field)? If the latter, the 400 mapping swallows a
 *    genuine infrastructure fault that must surface as 503.
 * 2. Does the overlay's substring test disagree with the index's tokenizer on a real corpus?
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

const directory = mkdtempSync(path.join(tmpdir(), "history-search-round2-probe-"))
const baseRequest: NativeHistoryListSearchRequest = {
  query: "hello",
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
    content: "hello world cartoon",
    endpoint: "anthropic-messages",
    state: "completed",
    sessionId: "s-1",
    requestModel: "m",
    responseModel: "m",
  })
  await index.flush()

  console.log("--- 1. is InvalidArg specific to query syntax? ---")
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["query syntax `foo:`", { ...baseRequest, query: "foo:" }],
    ["missing `limit`", { ...baseRequest, limit: undefined }],
    ["missing `direction`", { ...baseRequest, direction: undefined }],
    ["missing `operationKinds`", { ...baseRequest, operationKinds: undefined }],
    ["mistyped `limit`", { ...baseRequest, limit: "ten" }],
  ]
  for (const [label, request] of malformed) {
    try {
      await index.listSearch(request as unknown as NativeHistoryListSearchRequest)
      console.log(`${label.padEnd(26)} OK (no throw)`)
    } catch (error) {
      console.log(`${label.padEnd(26)} code=${JSON.stringify((error as { code?: unknown }).code)} message=${(error as Error).message.slice(0, 45)}`)
    }
  }

  console.log("--- 2. substring vs tokenized ---")
  const corpus = "hello world cartoon"
  for (const needle of ["hello", "orld", "art", "cartoon", "world"]) {
    const result = await index.listSearch({ ...baseRequest, query: needle })
    console.log(`needle=${needle.padEnd(9)} tantivy total=${result.total}  js substring=${corpus.toLowerCase().includes(needle.toLowerCase())}`)
  }
  await index.close()
} finally {
  rmSync(directory, { recursive: true, force: true })
}

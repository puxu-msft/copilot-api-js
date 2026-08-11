import { describe, expect, test } from "bun:test"

import { historySnapshotBody, snapshotHistoryBody, type HistoryBodySnapshot } from "~/lib/pipeline/types"

describe("HistoryBodySnapshot", () => {
  test("owns a cloned history body and rejects a caller-forged alias", () => {
    const source = { messages: [{ content: "before" }] }
    const snapshot = snapshotHistoryBody(source)
    source.messages[0].content = "after"

    expect(historySnapshotBody(snapshot)).toEqual({ messages: [{ content: "before" }] })
    expect(() => historySnapshotBody({ body: source } as unknown as HistoryBodySnapshot)).toThrow("must be created by snapshotHistoryBody")
  })
})

import { describe, expect, test } from "bun:test"

import type { OperationSyntheticKind } from "~/lib/context/model-operation-record"

import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

describe("SyntheticOriginKind + OperationSyntheticKind both include buffered-terminal-repair", () => {
  test("tagFrameSynthetic accepts the new kind", () => {
    const frame = tagFrameSynthetic({ data: "{}" }, "buffered-terminal-repair")
    expect(frame.data).toBe("{}")
  })

  test("OperationSyntheticKind (the SseEventRecord.synthetic type) accepts the same literal — the two unions must stay in a superset relationship", () => {
    const kind: OperationSyntheticKind = "buffered-terminal-repair"
    expect(kind).toBe("buffered-terminal-repair")
  })
})

import {
  //
  expect,
  test,
} from "bun:test"

import type { OperationSyntheticKind } from "~/lib/context/model-operation-record"
import type { UpstreamRequestLeg } from "~/lib/history/types"

test("OperationSyntheticKind accepts continuation", () => {
  const kind: OperationSyntheticKind = "continuation"

  expect(kind).toBe("continuation")
})

test("UpstreamRequestLeg accepts a synthetic provenance marker", () => {
  const leg: UpstreamRequestLeg = { format: "anthropic-messages", synthetic: "continuation" }

  expect(leg.synthetic).toBe("continuation")
})

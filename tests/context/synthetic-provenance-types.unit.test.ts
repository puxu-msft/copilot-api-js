import {
  //
  expect,
  test,
} from "bun:test"

import type { OperationSyntheticKind } from "~/lib/context/model-operation-record"

test("OperationSyntheticKind accepts continuation", () => {
  const kind: OperationSyntheticKind = "continuation"

  expect(kind).toBe("continuation")
})

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  resetConfigManagedState,
  setResponsesConfig,
} from "~/lib/state"
import { resolveResponsesBufferedMerge } from "~/routes/responses/buffered-config"

describe("resolveResponsesBufferedMerge", () => {
  afterEach(() => resetConfigManagedState())

  test("reads the two knobs from state", () => {
    setResponsesConfig({ responsesBufferedMergeEventCompaction: "verbatim", responsesBufferedMergeCompletedOutput: "upstream" })
    expect(resolveResponsesBufferedMerge()).toEqual({ eventCompaction: "verbatim", completedOutput: "upstream" })
  })

  test("defaults reflect spec §3 (drop-delta / repair-if-incomplete)", () => {
    expect(resolveResponsesBufferedMerge()).toEqual({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
  })
})

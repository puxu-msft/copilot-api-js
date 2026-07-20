import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  CONFIG_MANAGED_DEFAULTS,
  resetConfigManagedState,
  setResponsesConfig,
  state,
} from "~/lib/state"

describe("state.responsesBufferedMergeEventCompaction / responsesBufferedMergeCompletedOutput", () => {
  afterEach(() => resetConfigManagedState())

  test("defaults match spec §3 (drop-delta / repair-if-incomplete)", () => {
    expect(CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction).toBe("drop-delta")
    expect(CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeCompletedOutput).toBe("repair-if-incomplete")
  })

  test("setResponsesConfig can override both fields", () => {
    setResponsesConfig({ responsesBufferedMergeEventCompaction: "item-summary", responsesBufferedMergeCompletedOutput: "rebuild" })
    expect(state.responsesBufferedMergeEventCompaction).toBe("item-summary")
    expect(state.responsesBufferedMergeCompletedOutput).toBe("rebuild")
  })
})

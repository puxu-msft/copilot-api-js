import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { PipelineInfo } from "~/lib/history/types"

describe("PipelineInfo.bufferedMerge", () => {
  test("accepts the new buffered-merge diagnostics shape", () => {
    const info: PipelineInfo = {
      bufferedMerge: {
        eventCompaction: "drop-delta",
        completedOutput: "repair-if-incomplete",
        droppedEventCount: 0,
        droppedEventBytes: 0,
        droppedEventTypes: [],
        repairedItemCount: 0,
        repairReasons: [],
        verbatimFallbacks: [],
      },
    }
    expect(info.bufferedMerge?.eventCompaction).toBe("drop-delta")
  })
})

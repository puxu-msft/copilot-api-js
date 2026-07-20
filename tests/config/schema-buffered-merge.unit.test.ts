import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { ResponsesConfigSchema } from "~/lib/config/schema"

describe("ResponsesConfigSchema.buffered_merge", () => {
  test("accepts the two orthogonal knobs with their default omitted (nullable)", () => {
    const parsed = ResponsesConfigSchema.parse({ buffered_merge: { event_compaction: "item-summary", completed_output: "rebuild" } })
    expect(parsed.buffered_merge?.event_compaction).toBe("item-summary")
    expect(parsed.buffered_merge?.completed_output).toBe("rebuild")
  })
  test("rejects an invalid event_compaction value (caught by safeParse, not this raw .parse — see validation.ts test in Task 4.2)", () => {
    expect(() => ResponsesConfigSchema.parse({ buffered_merge: { event_compaction: "not-a-real-mode" } })).toThrow()
  })
})

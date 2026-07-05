import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  DEFAULT_COLUMN_VISIBILITY,
  MODEL_COLUMNS,
  mergeColumnVisibility,
} from "@/lib/model-columns"

describe("model-columns", () => {
  it("defaults: most visible, requests7d hidden", () => {
    expect(DEFAULT_COLUMN_VISIBILITY.context).toBe(true)
    expect(DEFAULT_COLUMN_VISIBILITY.requests7d).toBe(false)
  })

  it("MODEL_COLUMNS has key+label for every column", () => {
    expect(MODEL_COLUMNS.length).toBeGreaterThan(0)
    for (const col of MODEL_COLUMNS) {
      expect(typeof col.label).toBe("string")
      expect(col.label.length).toBeGreaterThan(0)
    }
  })

  it("mergeColumnVisibility retains defaults for missing keys (retain-on-absence)", () => {
    const merged = mergeColumnVisibility({ context: false })
    expect(merged.context).toBe(false) // persisted override kept
    expect(merged.requests7d).toBe(false) // missing key → default
    expect(merged.vendor).toBe(true) // missing key → default
  })

  it("mergeColumnVisibility ignores unknown persisted keys and non-object input", () => {
    expect(mergeColumnVisibility(null)).toEqual(DEFAULT_COLUMN_VISIBILITY)
    const merged = mergeColumnVisibility({ bogus: true } as never)
    expect(merged).toEqual(DEFAULT_COLUMN_VISIBILITY)
  })
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { useModelColumns } from "@/composables/useModelColumns"

describe("useModelColumns", () => {
  test("defaults: most columns visible, requests7d hidden", () => {
    const c = useModelColumns()
    expect(c.isVisible("context")).toBe(true)
    expect(c.isVisible("billing")).toBe(true)
    expect(c.isVisible("requests7d")).toBe(false)
  })

  test("toggle flips visibility", () => {
    const c = useModelColumns()
    c.toggle("context")
    expect(c.isVisible("context")).toBe(false)
    c.toggle("requests7d")
    expect(c.isVisible("requests7d")).toBe(true)
  })

  test("reset restores defaults", () => {
    const c = useModelColumns()
    c.toggle("context")
    c.toggle("requests7d")
    c.reset()
    expect(c.isVisible("context")).toBe(true)
    expect(c.isVisible("requests7d")).toBe(false)
  })

  test("ALL_COLUMNS lists every toggleable column with a label", () => {
    const c = useModelColumns()
    expect(c.ALL_COLUMNS.length).toBeGreaterThan(0)
    for (const col of c.ALL_COLUMNS) {
      expect(typeof col.label).toBe("string")
      expect(col.label.length).toBeGreaterThan(0)
    }
  })
})

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "vitest"

import ModelsColumnMenu from "@/components/models/ModelsColumnMenu.vue"
import { useModelColumns } from "@/composables/useModelColumns"

import { mountWithVuetifyStubs } from "./helpers/mount"

describe("ModelsColumnMenu", () => {
  // Column visibility persists to localStorage; isolate each test.
  beforeEach(() => {
    localStorage.clear()
  })
  test("toggles a column when its checkbox is clicked", async () => {
    const columns = useModelColumns()
    columns.reset()
    expect(columns.isVisible("context")).toBe(true)

    const w = mountWithVuetifyStubs(ModelsColumnMenu, { props: { columns } })
    const contextCheckbox = w.find('input[data-col="context"]')
    expect(contextCheckbox.exists()).toBe(true)
    await contextCheckbox.setValue(false)

    expect(columns.isVisible("context")).toBe(false)
  })

  test("reset button restores defaults", async () => {
    const columns = useModelColumns()
    columns.toggle("context")
    expect(columns.isVisible("context")).toBe(false)

    const w = mountWithVuetifyStubs(ModelsColumnMenu, { props: { columns } })
    await w.find('button[data-testid="columns-reset"]').trigger("click")
    expect(columns.isVisible("context")).toBe(true)
  })
})

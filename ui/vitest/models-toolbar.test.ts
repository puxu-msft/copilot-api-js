import {
  //
  describe,
  expect,
  test,
} from "vitest"

import ModelsToolbar from "@/components/models/ModelsToolbar.vue"
import { useModelColumns } from "@/composables/useModelColumns"

import { mountWithVuetifyStubs } from "./helpers/mount"

describe("ModelsToolbar", () => {
  test("CSV button emits exportCsv", async () => {
    const w = mountWithVuetifyStubs(ModelsToolbar, {
      props: { filteredCount: 1, totalCount: 1, vendorCount: 1, endpointCount: 1, columns: useModelColumns() },
    })
    const csvBtn = w.findAll("button").find((b) => b.text().includes("CSV"))
    expect(csvBtn?.exists()).toBe(true)
    await csvBtn!.trigger("click")
    expect(w.emitted("exportCsv")).toBeTruthy()
  })

  test("Raw JSON button emits openRawJson", async () => {
    const w = mountWithVuetifyStubs(ModelsToolbar, {
      props: { filteredCount: 1, totalCount: 1, vendorCount: 1, endpointCount: 1, columns: useModelColumns() },
    })
    const rawBtn = w.findAll("button").find((b) => b.text().includes("Raw JSON"))
    await rawBtn!.trigger("click")
    expect(w.emitted("openRawJson")).toBeTruthy()
  })
})

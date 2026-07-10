import {
  //
  describe,
  expect,
  test,
} from "vitest"

import type { EntrySummary } from "@/types"

import ActivityRow from "@/components/activity/ActivityRow.vue"

import { mountWithVuetifyStubs } from "./helpers/mount"

function entry(over: Partial<EntrySummary> = {}): EntrySummary {
  return { id: "e1", startedAt: 0, endpoint: "anthropic-messages", messageCount: 0, previewText: "", responsePreviewText: "", ...over }
}

function mountRow(e: EntrySummary) {
  return mountWithVuetifyStubs(ActivityRow, { props: { entry: e } })
}

describe("ActivityRow", () => {
  test("completed row shows model + status label + preview (no failure styling)", () => {
    const w = mountRow(entry({ state: "completed", responseModel: "opus", previewText: "hello world" }))
    expect(w.text()).toContain("opus")
    expect(w.text()).toContain("Completed")
    expect(w.text()).toContain("hello world")
    expect(w.find(".preview-failure").exists()).toBe(false)
  })

  test("failed row shows structured failure attribution (not preview)", () => {
    const w = mountRow(entry({ state: "failed", currentStrategy: "auto-truncate", attemptCount: 2, responseError: "boom" }))
    const t = w.text()
    expect(t).toContain("failed")
    expect(t).toContain("auto-truncate")
    expect(t).toContain("boom")
    expect(w.find(".preview-failure").exists()).toBe(true)
  })

  test("aborted row renders the Aborted status chip", () => {
    expect(mountRow(entry({ state: "aborted" })).text()).toContain("Aborted")
  })

  test("clicking the row emits open with the entry id", async () => {
    const w = mountRow(entry({ id: "abc" }))
    await w.trigger("click")
    expect(w.emitted("open")?.[0]).toEqual(["abc"])
  })

  test("cache-read tokens surface in their column", () => {
    const w = mountRow(entry({ state: "completed", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 4096 } }))
    expect(w.text()).toContain("K") // formatted cache tokens (e.g. 4.1K)
  })

  test("selected row gets the is-selected class", () => {
    const w = mountWithVuetifyStubs(ActivityRow, { props: { entry: entry(), selected: true } })
    expect(w.find(".is-selected").exists()).toBe(true)
  })
})

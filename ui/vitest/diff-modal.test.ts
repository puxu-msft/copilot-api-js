import {
  //
  describe,
  expect,
  test,
} from "vitest"

import type { MessageContent } from "@/types"

import DiffModal from "@/components/detail/DiffModal.vue"

import {
  //
  mountWithVuetifyStubs,
  vuetifyComponentStubs,
} from "./helpers/mount"

const VDialogStub = { name: "VDialog", template: "<div><slot /></div>" }

function mountModal(original: MessageContent, effective: MessageContent) {
  return mountWithVuetifyStubs(DiffModal, {
    props: { visible: true, original, effective, label: "user #1" },
    global: {
      components: { ...vuetifyComponentStubs, VDialog: VDialogStub },
      stubs: { ContentRenderer: true, SideBySideView: true },
    },
  })
}

describe("DiffModal", () => {
  test("unified view shows word-level highlights on changed lines", () => {
    const w = mountModal({ role: "user", content: "the quick fox" }, { role: "user", content: "the slow fox" })
    expect(w.find(".w-del").exists()).toBe(true) // removed word highlighted
    expect(w.find(".w-add").exists()).toBe(true) // added word highlighted
  })

  test("renders old/new line-number gutters", () => {
    const w = mountModal({ role: "user", content: "a\nb" }, { role: "user", content: "a\nB" })
    expect(w.findAll(".u-no").length).toBeGreaterThan(0)
  })

  test("collapses long runs of unchanged lines into an expandable gap", async () => {
    // Array content → pretty-JSON spans many lines; identical except one block.
    const blocks = (last: string) => [...Array.from({ length: 20 }, (_, i) => ({ type: "text", text: `line ${i}` })), { type: "text", text: last }]
    const w = mountModal({ role: "user", content: blocks("same") as never }, { role: "user", content: blocks("CHANGED") as never })
    const gap = w.find(".u-gap")
    expect(gap.exists()).toBe(true)
    const before = w.findAll(".u-row").length
    await gap.trigger("click")
    expect(w.findAll(".u-row").length).toBeGreaterThan(before) // expanding reveals more rows
  })

  test("+/− stats reflect added/removed line counts", () => {
    const w = mountModal({ role: "user", content: "x" }, { role: "user", content: "y" })
    expect(w.text()).toContain("+1")
    expect(w.text()).toContain("−1")
  })

  test("close emits update:visible false", async () => {
    const w = mountModal({ role: "user", content: "a" }, { role: "user", content: "b" })
    // The last action button is the close (mdi-close) button.
    await w.findAll("button").at(-1)!.trigger("click")
    expect(w.emitted("update:visible")).toBeTruthy()
  })
})

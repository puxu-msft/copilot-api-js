import {
  //
  describe,
  expect,
  test,
} from "vitest"

import DetailKeyValueList from "@/components/models/detail/DetailKeyValueList.vue"
import DetailSection from "@/components/models/detail/DetailSection.vue"

import { mountWithVuetifyStubs } from "./helpers/mount"

describe("DetailKeyValueList", () => {
  test("renders label/value rows and shows — for null", () => {
    const w = mountWithVuetifyStubs(DetailKeyValueList, {
      props: {
        rows: [
          ["Vendor", "Anthropic"],
          ["Family", null],
        ],
      },
    })
    expect(w.text()).toContain("Vendor")
    expect(w.text()).toContain("Anthropic")
    expect(w.text()).toContain("Family")
    expect(w.text()).toContain("—")
  })
})

describe("DetailSection", () => {
  test("renders the title and default slot content", () => {
    const w = mountWithVuetifyStubs(DetailSection, { props: { title: "Limits" }, slots: { default: "body-content" } })
    expect(w.text()).toContain("Limits")
    expect(w.text()).toContain("body-content")
  })
})

import { mount } from "@vue/test-utils"
import {
  //
  describe,
  expect,
  test,
} from "vitest"
import {
  //
  defineComponent,
  h,
} from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
  SseEventRecord,
} from "@/types"

import AttemptDiff from "@/components/detail/AttemptDiff.vue"
import DiagnosticSummary from "@/components/detail/DiagnosticSummary.vue"
import MessageDiffView from "@/components/detail/MessageDiffView.vue"
import SseFrameDiff from "@/components/detail/SseFrameDiff.vue"
import StageTabs from "@/components/detail/StageTabs.vue"
import {
  //
  provideMessageActions,
  useMessageActions,
} from "@/composables/useMessageActions"

import {
  //
  mountWithVuetifyStubs,
  vuetifyComponentStubs,
} from "./helpers/mount"

const sectionStub = { name: "SectionBlock", template: "<div><slot /></div>" }
const tabsStubs = { VTabs: { template: "<div><slot /></div>" }, VTab: { template: "<button class='v-tab' @click=\"$emit('click')\"><slot /></button>" } }

describe("StageTabs", () => {
  const stages = [
    { key: "inbound", label: "Inbound", icon: "mdi-x", present: true, tocIds: [] },
    { key: "wire", label: "Wire", icon: "mdi-x", present: true, tocIds: [] },
  ]
  test("renders a tab per stage", () => {
    const w = mountWithVuetifyStubs(StageTabs, { props: { stages, active: "inbound" }, global: { components: { ...vuetifyComponentStubs, ...tabsStubs } } })
    expect(w.text()).toContain("Inbound")
    expect(w.text()).toContain("Wire")
  })
})

describe("DiagnosticSummary", () => {
  function entry(over: Partial<HistoryEntry>): HistoryEntry {
    return { id: "e", endpoint: "anthropic-messages", startedAt: 0, inboundRequest: { model: "m" }, ...over } as HistoryEntry
  }
  test("aborted → status chip + 'client disconnected' reason", () => {
    const w = mountWithVuetifyStubs(DiagnosticSummary, { props: { entry: entry({ state: "aborted" }) } })
    expect(w.text()).toContain("Aborted")
    expect(w.text().toLowerCase()).toContain("client disconnected")
  })
  test("interrupted → reason names the dead pid", () => {
    const w = mountWithVuetifyStubs(DiagnosticSummary, { props: { entry: entry({ state: "interrupted", process: { pid: 4321, bootTime: 1, version: "v" } }) } })
    expect(w.text()).toContain("4321")
  })
  test("tokens (in/out/cache) shown when usage present", () => {
    const w = mountWithVuetifyStubs(DiagnosticSummary, {
      props: {
        entry: entry({
          state: "completed",
          outboundResponse: { success: true, model: "m", usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 512 }, content: null },
        }),
      },
    })
    expect(w.text()).toContain("tokens")
  })
})

describe("MessageDiffView", () => {
  const m = (role: string, content: string): MessageContent => ({ role, content })
  test("renders removed / added / modified rows with stats", () => {
    const w = mount(MessageDiffView, {
      props: { left: [m("user", "keep"), m("user", "gone"), m("user", "old")], right: [m("user", "keep"), m("user", "old-changed")] },
    })
    expect(w.text()).toContain("−") // removed marker present
    expect(w.find(".msg-removed").exists() || w.find(".msg-modified").exists()).toBe(true)
  })
})

describe("SseFrameDiff", () => {
  const f = (offsetMs: number, type: string, raw: string): SseEventRecord => ({ offsetMs, type, raw })
  test("renders dropped/rewritten frames between upstream and forwarded", () => {
    const w = mountWithVuetifyStubs(SseFrameDiff, {
      props: { upstream: [f(0, "a", "1"), f(1, "filtered", "x")], forwarded: [f(0, "a", "1")] },
      global: { components: { ...vuetifyComponentStubs }, stubs: { SectionBlock: sectionStub } },
    })
    expect(w.text()).toContain("filtered") // the dropped frame is shown
  })
})

describe("AttemptDiff", () => {
  test("shows per-retry message diff when attempts carry wire payloads", () => {
    const attempts = [
      {
        index: 0,
        durationMs: 1,
        wireRequest: {
          messages: [
            { role: "user", content: "a" },
            { role: "user", content: "b" },
          ],
        },
      },
      { index: 1, durationMs: 1, wireRequest: { messages: [{ role: "user", content: "a" }] } }, // dropped "b"
    ] as never
    const w = mountWithVuetifyStubs(AttemptDiff, { props: { attempts }, global: { components: { ...vuetifyComponentStubs } } })
    expect(w.findComponent(MessageDiffView).exists()).toBe(true)
  })
})

describe("useMessageActions provide/inject", () => {
  test("child injects the provided actions; standalone falls back to no-ops", () => {
    const calls: Array<string> = []
    const Child = defineComponent({
      setup() {
        const a = useMessageActions()
        a.jumpToCounterpart(2)
        return () => h("div")
      },
    })
    const Parent = defineComponent({
      setup(_, { slots }) {
        provideMessageActions({ openDiff: () => calls.push("diff"), jumpToCounterpart: (i) => calls.push(`jump:${i}`) })
        return () => h("div", slots.default?.())
      },
    })
    mount(Parent, { slots: { default: () => h(Child) } })
    expect(calls).toContain("jump:2")

    // No provider → defaults, no throw.
    const Solo = defineComponent({
      setup() {
        const a = useMessageActions()
        expect(() => a.openDiff({ role: "user", content: "x" }, { role: "user", content: "y" }, "l")).not.toThrow()
        return () => h("div")
      },
    })
    mount(Solo)
  })
})

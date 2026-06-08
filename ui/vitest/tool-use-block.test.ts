import { mount } from "@vue/test-utils"
import {
  //
  describe,
  expect,
  test,
  vi,
} from "vitest"
import VueJsonPretty from "vue-json-pretty"

import ToolUseBlock from "@/components/message/ToolUseBlock.vue"

// vitest hoists vi.mock above imports, so the mock is active when ToolUseBlock loads.
vi.mock("@/composables/useContentContext", () => ({
  useContentContext: () => ({
    aggregateTools: { value: false },
    toolResultMap: { value: {} },
    scrollToResult: () => {},
  }),
}))

const stubs = {
  ContentBlockWrapper: { template: "<div><slot /></div>" },
  VueJsonPretty: true,
  ToolResultBlock: true,
}

function mountBlock(block: Record<string, unknown>) {
  return mount(ToolUseBlock, { props: { block } as never, global: { stubs } })
}

describe("ToolUseBlock display-only decode", () => {
  test("decodes a stringified questions field for the JSON tree", () => {
    const w = mountBlock({
      type: "tool_use",
      id: "t1",
      name: "AskUserQuestion",
      input: { questions: '[{"h":1}]' },
    })
    const vjp = w.findComponent(VueJsonPretty)
    expect(vjp.exists()).toBe(true)
    // questions string decoded to an array passed into the JSON tree
    expect(vjp.props("data")).toEqual({ questions: [{ h: 1 }] })
  })

  test("does not touch the _parseError marker (short-circuits decode)", () => {
    const w = mountBlock({
      type: "tool_use",
      id: "t1",
      name: "X",
      input: { _parseError: true, _rawInput: '{"a":' },
    })
    // parse-error branch renders raw text, never the JSON tree
    expect(w.findComponent(VueJsonPretty).exists()).toBe(false)
    expect(w.text()).toContain("Failed to parse")
  })

  test("leaves an already-structured input unchanged", () => {
    const w = mountBlock({
      type: "tool_use",
      id: "t1",
      name: "AskUserQuestion",
      input: { questions: [{ h: 1 }] },
    })
    expect(w.findComponent(VueJsonPretty).props("data")).toEqual({ questions: [{ h: 1 }] })
  })
})

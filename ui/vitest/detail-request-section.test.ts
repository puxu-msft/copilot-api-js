import {
  //
  describe,
  expect,
  test,
} from "vitest"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import DetailRequestSection from "@/components/detail/DetailRequestSection.vue"

import {
  //
  mountWithVuetifyStubs,
} from "./helpers/mount"

// Stub the leaf components so we can assert on the messages DetailRequestSection
// chooses to render. MessageBlock exposes its `message` role + a marker so each
// rendered block is countable/identifiable.
const stubs = {
  MessageBlock: {
    name: "MessageBlock",
    props: ["message", "index", "isRewritten", "rewrittenMessage"],
    template: `<div class="msg-block" :data-role="message.role" :data-index="index">{{ typeof message.content === 'string' ? message.content : (message.content?.[0]?.type ?? '') }}</div>`,
  },
  SystemMessage: { name: "SystemMessage", template: "<div class='system-message' />" },
  ErrorBoundary: { name: "ErrorBoundary", template: "<div><slot /></div>" },
  SectionBlock: { name: "SectionBlock", template: "<div><slot /></div>" },
  TruncationDivider: { name: "TruncationDivider", template: "<div class='trunc' />" },
}

function entry(): HistoryEntry {
  return { id: "e", endpoint: "anthropic-messages", startedAt: 0, clientRequest: { model: "m" } } as HistoryEntry
}

function assistantHead(): MessageContent {
  return { role: "assistant", content: [{ type: "tool_use", id: "srvtoolu_1", name: "web_search", input: {} }] } as MessageContent
}
function splitUser(): MessageContent {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: "srvtoolu_1", content: "results" }] } as MessageContent
}

function baseProps() {
  return {
    entry: entry(),
    requestBadge: "1 messages",
    filteredMessages: [{ msg: assistantHead(), originalIndex: 1 }],
    truncationPoint: null,
    searchQuery: "",
    detailFilterType: "",
    detailViewMode: "rewritten" as const,
    hasMatchingBlockType: () => true,
    isMessageTruncated: () => false,
    isMessageRewritten: () => true,
    getRewrittenMessage: () => assistantHead(),
  }
}

describe("DetailRequestSection — split-out message rendering", () => {
  test("renders the head plus each split-out message when getSplitMessages is provided (Effective stage)", () => {
    const w = mountWithVuetifyStubs(DetailRequestSection, {
      props: { ...baseProps(), getSplitMessages: (index: number) => (index === 1 ? [splitUser()] : []) },
      global: { stubs },
    })
    const blocks = w.findAll(".msg-block")
    expect(blocks.length).toBe(2)
    // head assistant first, split-out user second
    expect(blocks[0].attributes("data-role")).toBe("assistant")
    expect(blocks[1].attributes("data-role")).toBe("user")
  })

  test("renders only the head when getSplitMessages is omitted (Inbound stage)", () => {
    const w = mountWithVuetifyStubs(DetailRequestSection, {
      props: baseProps(), // no getSplitMessages
      global: { stubs },
    })
    const blocks = w.findAll(".msg-block")
    expect(blocks.length).toBe(1)
    expect(blocks[0].attributes("data-role")).toBe("assistant")
  })

  test("renders no extra block when getSplitMessages returns [] (1:1 turn)", () => {
    const w = mountWithVuetifyStubs(DetailRequestSection, {
      props: { ...baseProps(), getSplitMessages: () => [] },
      global: { stubs },
    })
    expect(w.findAll(".msg-block").length).toBe(1)
  })
})

import { mount } from "@vue/test-utils"
import { describe, expect, test } from "vitest"

import type { HistoryEntry } from "@/types"

import MetaInfo from "@/components/detail/MetaInfo.vue"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "entry-1",
    sessionId: "session-1",
    startedAt: Date.now(),
    endpoint: "openai-chat-completions",
    request: {
      model: "gpt-5-resp",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
    response: {
      success: true,
      model: "gpt-5-resp",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: null,
    },
    ...overrides,
  }
}

describe("MetaInfo", () => {
  test("renders warning messages", () => {
    const wrapper = mount(MetaInfo, {
      props: {
        entry: makeEntry({
          warningMessages: [
            {
              code: "cc_to_responses_dropped_params",
              message: "Chat Completions -> Responses translation dropped unsupported params: stop, seed",
            },
          ],
        }),
      },
    })

    expect(wrapper.text()).toContain("Warnings")
    expect(wrapper.text()).toContain("cc_to_responses_dropped_params")
    expect(wrapper.text()).toContain(
      "Chat Completions -> Responses translation dropped unsupported params: stop, seed",
    )
  })
})

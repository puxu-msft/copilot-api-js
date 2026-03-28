import { afterEach, describe, expect, test } from "bun:test"

import { prepareChatCompletionsRequest } from "~/lib/openai/client"
import { prepareResponsesRequest } from "~/lib/openai/responses-client"
import { state } from "~/lib/state"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

const originalCopilotToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType

afterEach(() => {
  state.copilotToken = originalCopilotToken
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
})

function initState() {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.100.0"
  state.accountType = "individual"
}

describe("prepareChatCompletionsRequest", () => {
  test("returns the outbound wire payload and agent headers", () => {
    initState()

    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      stream: true,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    }

    const prepared = prepareChatCompletionsRequest(payload)

    expect(prepared.wire).toEqual(payload)
    expect(prepared.headers["X-Initiator"]).toBe("agent")
    expect(prepared.headers["content-type"]).toBe("application/json")
  })
})

describe("prepareResponsesRequest", () => {
  test("returns the outbound wire payload and agent headers", () => {
    initState()

    const payload: ResponsesPayload = {
      model: "gpt-5.4",
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "function_call", id: "fc_1", call_id: "fc_1", name: "read_file", arguments: "{}" },
      ],
    }

    const prepared = prepareResponsesRequest(payload)

    expect(prepared.wire).toEqual(payload)
    expect(prepared.headers["X-Initiator"]).toBe("agent")
    expect(prepared.headers["content-type"]).toBe("application/json")
  })
})

import { afterAll, afterEach, beforeAll, test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { createChatCompletions } from "~/lib/openai/client"
import { state } from "~/lib/state"

// Save and mock global state
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType

const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
  return {
    ok: true,
    json: () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts.headers,
  }
})

beforeAll(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock
})

afterEach(() => {
  fetchMock.mockClear()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
})

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers["X-Initiator"]).toBe("user")
})

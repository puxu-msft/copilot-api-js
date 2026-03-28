import { afterAll, afterEach, beforeAll, test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { createChatCompletions } from "~/lib/openai/client"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

// Save and mock global state
const originalFetch = globalThis.fetch
const originalState = snapshotStateForTests()

const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
  return {
    ok: true,
    json: () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts.headers,
  }
})

beforeAll(() => {
  setStateForTests({
    copilotToken: "test-token",
    vsCodeVersion: "1.0.0",
    accountType: "individual",
  })
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock
})

afterEach(() => {
  fetchMock.mockClear()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  restoreStateForTests(originalState)
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

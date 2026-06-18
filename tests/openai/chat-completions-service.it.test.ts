import {
  //
  afterAll,
  afterEach,
  beforeAll,
  test,
  expect,
  mock,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { createChatCompletions } from "~/lib/openai/chat-completions-client"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import {
  //
  applyFetchMock,
  restoreFetch,
} from "../helpers/mock-fetch"

// Save and mock global state
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
  applyFetchMock(fetchMock)
})

afterEach(() => {
  fetchMock.mockClear()
})

afterAll(() => {
  restoreFetch()
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

test("drives the upstream timeout from our application-level abort signal", async () => {
  // The upstream request now goes through undici (transport/upstream-fetch.ts),
  // which has no built-in timeout clock (unlike Bun's global fetch, which had a
  // 300s one). So `timeouts.response_header` stays the single source of truth,
  // carried via the abort signal on the request rather than a `timeout:false` flag.
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  const init = fetchMock.mock.calls[0][1] as { signal?: unknown }
  expect(init.signal).toBeInstanceOf(AbortSignal)
})

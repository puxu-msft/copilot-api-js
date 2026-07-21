import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { prepareChatCompletionsRequest } from "~/lib/openai/chat-completions-client"
import { prepareResponsesRequest } from "~/lib/openai/responses-client"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

function initState() {
  setStateForTests({
    copilotToken: "test-token",
    vsCodeVersion: "1.100.0",
    accountType: "individual",
  })
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

  test("extracts `session_id` from Claude Code's JSON user_id blob to fit the 64-char limit", () => {
    initState()

    // Claude Code sends a ~150-char JSON blob as metadata.user_id that the anthropic→cc translation
    // maps onto `user`; the OpenAI /chat/completions endpoint rejects any `user` longer than 64
    // chars. Single-user proxy → device_id/account_uuid are constant, session_id is the meaningful part.
    const sessionId = "7654802f-e457-41c1-918b-47b2995359ac"
    const userBlob = `{"device_id":"cdcc971dd7087e338fbf6a0fa9a9cc75bb5d45613fd7d3badf6e8ce685ce5f7d","account_uuid":"","session_id":"${sessionId}"}`
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      user: userBlob,
    }

    const prepared = prepareChatCompletionsRequest(payload)

    expect(prepared.wire.user).toBe(sessionId)
    expect(prepared.wire.user!.length).toBeLessThanOrEqual(64)
  })

  test("truncates a non-JSON over-length `user` as a fallback", () => {
    initState()

    const longUser = `plain_${"a".repeat(150)}`
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      user: longUser,
    }

    const prepared = prepareChatCompletionsRequest(payload)

    expect(prepared.wire.user).toBe(longUser.slice(0, 64))
    expect(prepared.wire.user!.length).toBe(64)
  })

  test("leaves a `user` within the 64-char limit untouched", () => {
    initState()

    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      user: "user_short",
    }

    const prepared = prepareChatCompletionsRequest(payload)

    expect(prepared.wire.user).toBe("user_short")
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

  test("extracts `session_id` from Claude Code's JSON user_id blob to fit the 64-char limit", () => {
    initState()

    const sessionId = "7654802f-e457-41c1-918b-47b2995359ac"
    const userBlob = `{"device_id":"cdcc971dd7087e338fbf6a0fa9a9cc75bb5d45613fd7d3badf6e8ce685ce5f7d","account_uuid":"","session_id":"${sessionId}"}`
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      user: userBlob,
    }

    const prepared = prepareResponsesRequest(payload)

    expect(prepared.wire.user).toBe(sessionId)
    expect(prepared.wire.user!.length).toBeLessThanOrEqual(64)
  })

  test("strips a non-`fc_` function_call item id at the wire (backstop for the upstream 400 'Expected an ID that begins with fc')", () => {
    initState()

    const payload: ResponsesPayload = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        // A `call_`/`toolu_`-prefixed id survives from a CC-origin or Anthropic-native tool call echoed
        // into a native Responses request — normalizeCallIds is call_-only and gated; this is the
        // unconditional last-mile catch-all.
        { type: "function_call", id: "call_jCWUMZ57P3JSaKR5wZBhrO8Z", call_id: "call_jCWUMZ57P3JSaKR5wZBhrO8Z", name: "get_weather", arguments: "{}" },
      ],
    }

    const prepared = prepareResponsesRequest(payload)
    const items = prepared.wire.input as Array<{ type?: string; id?: string; call_id?: string }>
    const fc = items.find((i) => i.type === "function_call")!
    expect(fc.id).toBeUndefined()
    // call_id is preserved untouched (matching key; upstream accepts a `call_`-prefixed call_id).
    expect(fc.call_id).toBe("call_jCWUMZ57P3JSaKR5wZBhrO8Z")
  })
})
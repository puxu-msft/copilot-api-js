import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  isClientContentFrame,
  isFirstUpstreamContent,
  isUpstreamContentFrame,
  recordLatest,
  recordOnce,
  type AttemptTiming,
} from "~/lib/pipeline/request-timing"

describe("recordTiming", () => {
  it("recordOnce keeps the FIRST write, ignores later", () => {
    const t: AttemptTiming = {}
    recordOnce(t, "upstreamHeadersAt", 100)
    recordOnce(t, "upstreamHeadersAt", 200)
    expect(t.upstreamHeadersAt).toBe(100)
  })
  it("recordLatest keeps the LAST write", () => {
    const t: AttemptTiming = {}
    recordLatest(t, "upstreamLastTokenAt", 100)
    recordLatest(t, "upstreamLastTokenAt", 200)
    expect(t.upstreamLastTokenAt).toBe(200)
  })
  it("recordOnce ignores undefined/null", () => {
    const t: AttemptTiming = {}
    recordOnce(t, "upstreamHeadersAt", undefined as unknown as number)
    expect(t.upstreamHeadersAt).toBeUndefined()
  })
})

const evt = (event: string, data = "{}") => ({ event, data })
const dataOnly = (data: string) => ({ data })

describe("isFirstUpstreamContent (keyed by targetEndpoint/UpstreamEndpoint)", () => {
  it("messages (anthropic upstream): content_block_start via event line", () => {
    expect(isFirstUpstreamContent(evt("content_block_start"), ENDPOINT.MESSAGES)).toBe(true)
    expect(isFirstUpstreamContent(evt("message_start"), ENDPOINT.MESSAGES)).toBe(false)
    expect(isFirstUpstreamContent(evt("ping"), ENDPOINT.MESSAGES)).toBe(false)
  })
  it("responses upstream: output_item.added / output_text.delta via event line", () => {
    expect(isFirstUpstreamContent(evt("response.output_item.added"), ENDPOINT.RESPONSES)).toBe(true)
    expect(isFirstUpstreamContent(evt("response.output_text.delta"), ENDPOINT.WS_RESPONSES)).toBe(true)
    expect(isFirstUpstreamContent(evt("response.created"), ENDPOINT.RESPONSES)).toBe(false)
  })
  it("chat_completions (openai upstream): data-only chunk, parse choices[].delta.content/tool_calls", () => {
    expect(isFirstUpstreamContent(dataOnly('{"choices":[{"delta":{"content":"hi"}}]}'), ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isFirstUpstreamContent(dataOnly('{"choices":[{"delta":{"tool_calls":[{}]}}]}'), ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isFirstUpstreamContent(dataOnly('{"choices":[{"delta":{"role":"assistant"}}]}'), ENDPOINT.CHAT_COMPLETIONS)).toBe(false)
  })
})

describe("isUpstreamContentFrame (any content frame, last_token 用)", () => {
  it("messages: content_block_delta 与 content_block_start 均算", () => {
    expect(isUpstreamContentFrame(evt("content_block_delta"), ENDPOINT.MESSAGES)).toBe(true)
    expect(isUpstreamContentFrame(evt("content_block_start"), ENDPOINT.MESSAGES)).toBe(true)
    expect(isUpstreamContentFrame(evt("message_stop"), ENDPOINT.MESSAGES)).toBe(false)
  })
})

describe("isClientContentFrame (keyed by clientFormat/ClientFormat)", () => {
  it("anthropic: content_block_delta 算，message_start/content_block_start 不算", () => {
    expect(isClientContentFrame(evt("content_block_delta"), "anthropic")).toBe(true)
    expect(isClientContentFrame(evt("message_start"), "anthropic")).toBe(false)
    expect(isClientContentFrame(evt("content_block_start"), "anthropic")).toBe(false)
  })
  it("openai-cc: data-only，parse choices[].delta.content/tool_calls", () => {
    expect(isClientContentFrame(dataOnly('{"choices":[{"delta":{"content":"hi"}}]}'), "openai-cc")).toBe(true)
    expect(isClientContentFrame(dataOnly('{"choices":[{"delta":{"role":"assistant"}}]}'), "openai-cc")).toBe(false)
  })
  it("gemini: data-only，parse candidates[].content.parts text/functionCall", () => {
    expect(isClientContentFrame(dataOnly('{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}'), "gemini")).toBe(true)
    expect(isClientContentFrame(dataOnly('{"candidates":[{"content":{"parts":[{"functionCall":{}}]}}]}'), "gemini")).toBe(true)
    expect(isClientContentFrame(dataOnly('{"candidates":[{"content":{"parts":[{}]}}]}'), "gemini")).toBe(false)
  })
  it("openai-responses: HTTP (has event) AND WS (data-only, no event) both trigger — review HIGH-1", () => {
    // HTTP responses: event line present.
    expect(isClientContentFrame(evt("response.output_text.delta"), "openai-responses")).toBe(true)
    // WS responses: restoreAccumulateCount strips the event line → data-only. Must parse data.type.
    expect(isClientContentFrame(dataOnly('{"type":"response.output_text.delta","delta":"hi"}'), "openai-responses")).toBe(true)
    // Non-content responses events (no event line, WS shape) → not content.
    expect(isClientContentFrame(dataOnly('{"type":"response.created"}'), "openai-responses")).toBe(false)
  })
})

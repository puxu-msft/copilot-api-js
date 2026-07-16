import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamEvent } from "~/types/api/anthropic"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
  getTextContent,
} from "~/lib/anthropic/stream-accumulator"
import { HTTPError } from "~/lib/error"
import {
  //
  clearHistory,
  initHistory,
  shutdownHistory,
} from "~/lib/history"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { readOrigin } from "~/lib/pipeline/hooks/origin"
import {
  //
  delay,
  mockAnthropicMessage,
  mockCcChunks,
  mockGeminiResponse,
  mockUpstreamError,
  rawStream,
  replayFromHistory,
  sse,
  streamOf,
  truncateAfter,
} from "~/lib/pipeline/hooks/toolkit"
import { CC_SUBFIELD_PRESENT as CACHE_CONTROL_SUBFIELD_PATTERN } from "~/lib/request/strategies/cache-control-subfield-rejection-retry"
import { SERVER_TOOL_REJECTION_TABLE } from "~/lib/request/strategies/server-tool-rejection-retry"
import { TOOL_FIELD_PRESENT } from "~/lib/request/strategies/tool-field-rejection-retry"
import { BETA_ERROR_PATTERN } from "~/lib/request/strategies/unsupported-beta-retry"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"
import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

import { autoRestoreState } from "../../helpers/state-fixture"

// Snapshot global state once and restore after every test — the `replayFromHistory` describe block
// below seeds the module-global history store (in-flight map + memory-backed SQLite), matching the
// established isolation pattern (tests/history/history-store.it.test.ts).
autoRestoreState()

beforeEach(() => {
  setStateForTests({ historyDbPath: ":memory:" })
  initHistory(true, 200)
})

afterEach(async () => {
  clearHistory()
  await shutdownHistory()
  setStateForTests({ historyDbPath: "" })
})

async function collect<T>(iter: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const item of iter) out.push(item)
  return out
}

/** Independent oracle helper: JSON-parse an Anthropic mock frame's `data` back into a StreamEvent. */
function parseAnthropicFrame(frame: { data?: string }): StreamEvent {
  return JSON.parse(frame.data ?? "{}") as StreamEvent
}

describe("sse", () => {
  test("builds a frame with event + JSON-serialized data", () => {
    const frame = sse("message_start", { type: "message_start" })

    expect(frame.event).toBe("message_start")
    expect(frame.data).toBe(JSON.stringify({ type: "message_start" }))
  })

  test("omits the event field when event is undefined", () => {
    const frame = sse(undefined, { type: "message" })

    expect(frame.event).toBeUndefined()
    expect(frame.data).toBe(JSON.stringify({ type: "message" }))
  })

  test("passes a string dataObj through verbatim (no double JSON-encoding)", () => {
    const frame = sse(undefined, "[DONE]")

    expect(frame.data).toBe("[DONE]")
  })
})

describe("rawStream", () => {
  test("iterates the given frames without any hook-origin tag", async () => {
    const frames = [sse("a", { x: 1 }), sse("b", { x: 2 })]
    const s = rawStream(frames)

    expect(await collect(s.frames)).toEqual(frames)
    expect(readOrigin(s)).toBeUndefined()
  })

  test("defaults headers to an empty Headers instance", () => {
    const s = rawStream([])

    expect(s.headers).toBeInstanceOf(Headers)
  })
})

describe("streamOf", () => {
  test("iterates the given frames", async () => {
    const frames = [sse("a", { x: 1 }), sse("b", { x: 2 })]
    const s = streamOf(frames)

    expect(await collect(s.frames)).toEqual(frames)
  })

  test("tags the stream hook-mock", () => {
    const s = streamOf([])

    expect(readOrigin(s)).toBe("hook-mock")
  })
})

describe("mockAnthropicMessage — independent oracle (Anthropic stream accumulator)", () => {
  test("reconstructs the given text and sees a mandatory message_stop terminator", async () => {
    const s = mockAnthropicMessage("hello world")
    const acc = createAnthropicStreamAccumulator()

    for await (const frame of s.frames) {
      accumulateAnthropicStreamEvent(parseAnthropicFrame(frame), acc)
    }

    expect(acc.sawMessageStop).toBe(true)
    expect(getTextContent(acc)).toBe("hello world")
  })

  test("is tagged hook-mock", () => {
    expect(readOrigin(mockAnthropicMessage("x"))).toBe("hook-mock")
  })

  test("every frame's event line matches its own JSON body's type field (real Anthropic wire convention)", async () => {
    const s = mockAnthropicMessage("hi")
    for await (const frame of s.frames) {
      expect(frame.event).toBe(parseAnthropicFrame(frame).type)
    }
  })
})

describe("mockCcChunks — independent oracle (OpenAI stream accumulator)", () => {
  test("reconstructs the given text and a stop finish_reason", async () => {
    const s = mockCcChunks("hello cc")
    const acc = createOpenAIStreamAccumulator()

    for await (const frame of s.frames) {
      if (frame.data === undefined || frame.data === "[DONE]") continue
      accumulateOpenAIStreamEvent(JSON.parse(frame.data) as ChatCompletionChunk, acc)
    }

    expect(acc.rawContent).toBe("hello cc")
    expect(acc.finishReason).toBe("stop")
  })

  test("is tagged hook-mock and carries no event line (real CC/OpenAI wire has none)", async () => {
    const s = mockCcChunks("x")
    expect(readOrigin(s)).toBe("hook-mock")
    for await (const frame of s.frames) expect(frame.event).toBeUndefined()
  })

  test("terminates the SSE sequence with a [DONE] sentinel", async () => {
    const frames = await collect(mockCcChunks("x").frames)
    expect(frames.at(-1)?.data).toBe("[DONE]")
  })
})

describe("mockGeminiResponse — independent oracle (source CC accumulator + response-shape parse)", () => {
  test("reconstructs the given text via the CC accumulator that fed the real CC→Gemini translator", async () => {
    // mockGeminiResponse is built by running the SAME CC chunks mockCcChunks would emit through the
    // production `createGeminiStreamTranslator` (~/lib/gemini/convert-stream) — so decoding the
    // pre-translation CC chunks independently corroborates the post-translation Gemini frames below,
    // rather than the mock self-asserting its own hand-rolled Gemini structure.
    const ccAcc = createOpenAIStreamAccumulator()
    for await (const frame of mockCcChunks("hello gemini").frames) {
      if (frame.data === undefined || frame.data === "[DONE]") continue
      accumulateOpenAIStreamEvent(JSON.parse(frame.data) as ChatCompletionChunk, ccAcc)
    }
    expect(ccAcc.rawContent).toBe("hello gemini")

    const frames = await collect(mockGeminiResponse("hello gemini").frames)
    let text = ""
    let sawFinish = false
    for (const frame of frames) {
      const payload = JSON.parse(frame.data ?? "{}") as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
      }
      for (const candidate of payload.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) text += part.text
        }
        if (candidate.finishReason) sawFinish = true
      }
    }

    expect(text).toBe("hello gemini")
    expect(sawFinish).toBe(true)
  })

  test("is tagged hook-mock and carries no event line (Gemini SSE has none)", async () => {
    const s = mockGeminiResponse("x")
    expect(readOrigin(s)).toBe("hook-mock")
    for await (const frame of s.frames) expect(frame.event).toBeUndefined()
  })
})

describe("mockUpstreamError", () => {
  test("throws a real HTTPError carrying status + a JSON-serialized body in responseText", () => {
    expect(() => mockUpstreamError(400, { error: { message: "boom" } })).toThrow(HTTPError)
    try {
      mockUpstreamError(503, { error: { message: "boom" } })
      throw new Error("mockUpstreamError should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(HTTPError)
      const err = e as HTTPError
      expect(err.status).toBe(503)
      expect(err.responseText).toBe(JSON.stringify({ error: { message: "boom" } }))
    }
  })

  test("accepts a raw string body verbatim (no double JSON-encoding)", () => {
    try {
      mockUpstreamError(400, "raw text body")
      throw new Error("mockUpstreamError should have thrown")
    } catch (e) {
      expect((e as HTTPError).responseText).toBe("raw text body")
    }
  })

  test("defaults body to {} when omitted", () => {
    try {
      mockUpstreamError(500)
      throw new Error("mockUpstreamError should have thrown")
    } catch (e) {
      expect((e as HTTPError).responseText).toBe("{}")
    }
  })

  describe("4 reactive-strategy presets — each responseText hits the SAME regex its real strategy uses (single source of truth, not a re-typed copy)", () => {
    test("toolFieldRejection hits tool-field-rejection-retry's TOOL_FIELD_PRESENT", () => {
      try {
        mockUpstreamError.toolFieldRejection()
        throw new Error("should have thrown")
      } catch (e) {
        expect(TOOL_FIELD_PRESENT.test((e as HTTPError).responseText)).toBe(true)
      }
    })

    test("serverToolRejection hits server-tool-rejection-retry's SERVER_TOOL_REJECTION_TABLE pattern", () => {
      try {
        mockUpstreamError.serverToolRejection()
        throw new Error("should have thrown")
      } catch (e) {
        const text = (e as HTTPError).responseText
        expect(SERVER_TOOL_REJECTION_TABLE.some((row) => row.pattern.test(text))).toBe(true)
      }
    })

    test("cacheControlSubfield hits cache-control-subfield-rejection-retry's CC_SUBFIELD_PRESENT", () => {
      try {
        mockUpstreamError.cacheControlSubfield()
        throw new Error("should have thrown")
      } catch (e) {
        expect(CACHE_CONTROL_SUBFIELD_PATTERN.test((e as HTTPError).responseText)).toBe(true)
      }
    })

    test("unsupportedBeta hits unsupported-beta-retry's BETA_ERROR_PATTERN", () => {
      try {
        mockUpstreamError.unsupportedBeta()
        throw new Error("should have thrown")
      } catch (e) {
        expect(BETA_ERROR_PATTERN.test((e as HTTPError).responseText)).toBe(true)
      }
    })

    test("each preset throws HTTPError with status 400", () => {
      for (const preset of [
        mockUpstreamError.toolFieldRejection,
        mockUpstreamError.serverToolRejection,
        mockUpstreamError.cacheControlSubfield,
        mockUpstreamError.unsupportedBeta,
      ]) {
        try {
          preset()
          throw new Error("should have thrown")
        } catch (e) {
          expect(e).toBeInstanceOf(HTTPError)
          expect((e as HTTPError).status).toBe(400)
        }
      }
    })
  })
})

/** Build + insert a minimal terminal `HistoryEntry` whose last attempt carries `sseEvents`, for
 *  `replayFromHistory` to read back. Mirrors `tests/helpers/history-fixtures.ts`'s `insertEntry`
 *  wiring, extended with the per-attempt `upstreamResponse.sseEvents` replayFromHistory reads. */
function insertReplayFixture(opts: {
  endpoint: "anthropic-messages" | "openai-chat-completions"
  model: string
  sseEvents: Array<{ offsetMs: number; type: string; raw: string; synthetic?: "keepalive" | "hook-mock" }>
}): string {
  const id = generateId()
  commitV3HistoryEntry({
    id,
    startedAt: Date.now(),
    endpoint: opts.endpoint,
    state: "completed",
    model: { requested: opts.model, resolved: opts.model },
    clientRequest: { format: opts.endpoint, model: opts.model, messages: [] },
    attempts: [
      {
        index: 0,
        durationMs: 1,
        upstreamResponse: {
          success: true,
          model: opts.model,
          usage: { input_tokens: 0, output_tokens: 0 },
          body: null,
          sseEvents: opts.sseEvents,
        },
      },
    ],
  })
  return id
}

describe("replayFromHistory", () => {
  test("Anthropic entry: replays with event lines (type is a REAL event name, lossless per H4)", async () => {
    const id = insertReplayFixture({
      endpoint: "anthropic-messages",
      model: "claude-mock",
      sseEvents: [
        { offsetMs: 0, type: "message_start", raw: JSON.stringify({ type: "message_start" }) },
        { offsetMs: 5, type: "content_block_delta", raw: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }) },
        { offsetMs: 10, type: "message_stop", raw: JSON.stringify({ type: "message_stop" }) },
      ],
    })

    const s = await replayFromHistory(id)
    expect(readOrigin(s)).toBe("hook-replay")
    const frames = await collect(s.frames)
    expect(frames).toEqual([
      { event: "message_start", data: JSON.stringify({ type: "message_start" }) },
      { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }) },
      { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
    ])
  })

  test('CC entry: replays WITHOUT event lines (type is a FABRICATED "message" label, per driver.ts\'s frame.event ?? "message")', async () => {
    const id = insertReplayFixture({
      endpoint: "openai-chat-completions",
      model: "gpt-mock",
      sseEvents: [
        { offsetMs: 0, type: "message", raw: JSON.stringify({ choices: [{ delta: { content: "hi" }, index: 0, finish_reason: null }] }) },
        { offsetMs: 5, type: "message", raw: JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }] }) },
      ],
    })

    const s = await replayFromHistory(id)
    expect(readOrigin(s)).toBe("hook-replay")
    const frames = await collect(s.frames)
    expect(frames.every((f) => f.event === undefined)).toBe(true)
    expect(frames.map((f) => f.data)).toEqual([
      JSON.stringify({ choices: [{ delta: { content: "hi" }, index: 0, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }] }),
    ])
  })

  test("filters out synthetic (keepalive/hook-*) records — only genuine upstream frames replay", async () => {
    const id = insertReplayFixture({
      endpoint: "anthropic-messages",
      model: "claude-mock",
      sseEvents: [
        { offsetMs: 0, type: "message_start", raw: JSON.stringify({ type: "message_start" }) },
        { offsetMs: 3, type: "ping", raw: JSON.stringify({ type: "ping" }), synthetic: "keepalive" },
        { offsetMs: 10, type: "message_stop", raw: JSON.stringify({ type: "message_stop" }) },
      ],
    })

    const frames = await collect((await replayFromHistory(id)).frames)
    expect(frames.map((f) => f.event)).toEqual(["message_start", "message_stop"])
  })

  test("string selector reads the entry by id (getEntry)", async () => {
    const id = insertReplayFixture({ endpoint: "anthropic-messages", model: "m1", sseEvents: [{ offsetMs: 0, type: "message_stop", raw: "{}" }] })
    const frames = await collect((await replayFromHistory(id)).frames)
    expect(frames).toHaveLength(1)
  })

  test("object selector filters by model and picks the latest match", async () => {
    insertReplayFixture({ endpoint: "anthropic-messages", model: "target-model", sseEvents: [{ offsetMs: 0, type: "message_start", raw: "older" }] })
    await Bun.sleep(2)
    const latestId = insertReplayFixture({
      endpoint: "anthropic-messages",
      model: "target-model",
      sseEvents: [{ offsetMs: 0, type: "message_start", raw: "newer" }],
    })
    insertReplayFixture({ endpoint: "anthropic-messages", model: "other-model", sseEvents: [{ offsetMs: 0, type: "message_start", raw: "unrelated" }] })

    const frames = await collect((await replayFromHistory({ model: "target-model" })).frames)
    expect(frames).toEqual([{ event: "message_start", data: "newer" }])

    // Cross-check: getEntry(latestId) really is the entry replayFromHistory picked.
    const byId = await collect((await replayFromHistory(latestId)).frames)
    expect(byId).toEqual(frames)
  })

  test("object selector filters by endpoint", async () => {
    insertReplayFixture({ endpoint: "openai-chat-completions", model: "shared-model", sseEvents: [{ offsetMs: 0, type: "message", raw: "cc-body" }] })
    insertReplayFixture({ endpoint: "anthropic-messages", model: "shared-model", sseEvents: [{ offsetMs: 0, type: "message_start", raw: "anthropic-body" }] })

    const frames = await collect((await replayFromHistory({ endpoint: "openai-chat-completions" })).frames)
    expect(frames).toEqual([{ event: undefined, data: "cc-body" }])
  })

  test("throws when no entry matches the selector", async () => {
    await expect(replayFromHistory("no-such-entry-id")).rejects.toThrow()
  })
})

describe("truncateAfter", () => {
  test("yields only the first n frames, dropping the rest", async () => {
    const [a, b, c] = [sse("a", { x: 1 }), sse("b", { x: 2 }), sse("c", { x: 3 })]
    const frames = await collect(truncateAfter(2, streamOf([a, b, c])).frames)

    expect(frames).toEqual([a, b])
  })

  test("yields all frames when n exceeds the stream length", async () => {
    const [a, b] = [sse("a", { x: 1 }), sse("b", { x: 2 })]
    const frames = await collect(truncateAfter(5, streamOf([a, b])).frames)

    expect(frames).toEqual([a, b])
  })

  test("yields nothing when n is 0", async () => {
    const frames = await collect(truncateAfter(0, streamOf([sse("a", { x: 1 })])).frames)

    expect(frames).toEqual([])
  })

  test("preserves the stream's headers and hook-origin tag (spreads the input stream)", () => {
    const s = streamOf([], new Headers({ "x-test": "1" }))
    const truncated = truncateAfter(2, s)

    expect(truncated.headers.get("x-test")).toBe("1")
    expect(readOrigin(truncated)).toBe("hook-mock")
  })
})

describe("delay", () => {
  test("resolves to the given value, having actually awaited (Bun.sleep, not a same-tick passthrough)", async () => {
    const start = performance.now()
    const result = await delay(5)("payload")
    const elapsed = performance.now() - start

    expect(result).toBe("payload")
    expect(elapsed).toBeGreaterThanOrEqual(4) // small slack for timer jitter
  })

  test("passes through non-string values untouched", async () => {
    const obj = { a: 1 }
    expect(await delay(1)(obj)).toBe(obj)
  })
})

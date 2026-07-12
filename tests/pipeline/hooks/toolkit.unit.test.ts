import {
  //
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
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { readOrigin } from "~/lib/pipeline/hooks/origin"
import {
  //
  mockAnthropicMessage,
  mockCcChunks,
  mockGeminiResponse,
  rawStream,
  sse,
  streamOf,
} from "~/lib/pipeline/hooks/toolkit"

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

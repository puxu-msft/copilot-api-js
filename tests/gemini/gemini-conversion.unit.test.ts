/**
 * Component tests for the Gemini conversion helpers — schema normalization,
 * tool-call pairing edge cases, and streaming translation.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Content } from "~/types/api/gemini"

import {
  //
  normalizeSchemaTypes,
  pairFunctionCalls,
  resolveCallId,
  resolveResponseId,
  SYNTHETIC_CALL_ID_PREFIX,
  translateOpenAIStreamToGemini,
} from "~/lib/gemini"

describe("normalizeSchemaTypes", () => {
  test("lowercases protocol-buffer style type values", () => {
    const input = {
      type: "OBJECT",
      properties: {
        name: { type: "STRING" },
        age: { type: "INTEGER" },
        tags: { type: "ARRAY", items: { type: "STRING" } },
      },
    }
    const out = normalizeSchemaTypes(input) as typeof input
    expect(out.type).toBe("object")
    expect(out.properties.name.type).toBe("string")
    expect(out.properties.age.type).toBe("integer")
    expect(out.properties.tags.type).toBe("array")
    expect(out.properties.tags.items.type).toBe("string")
  })

  test("strips TYPE_UNSPECIFIED", () => {
    const input = { type: "TYPE_UNSPECIFIED", description: "x" }
    const out = normalizeSchemaTypes(input) as Record<string, unknown>
    expect(out.type).toBeUndefined()
    expect(out.description).toBe("x")
  })

  test("does not recurse into enum / default / example / const", () => {
    const input = {
      type: "STRING",
      enum: [{ type: "value-shaped-thing" }],
      default: { type: "STRING" },
    }
    const out = normalizeSchemaTypes(input) as { enum: Array<{ type: string }>; default: { type: string } }
    // enum / default values left untouched (treated as literal data)
    expect(out.enum[0].type).toBe("value-shaped-thing")
    expect(out.default.type).toBe("STRING")
  })

  test("survives circular references", () => {
    const a: Record<string, unknown> = { type: "OBJECT" }
    a.child = a // circular
    expect(() => normalizeSchemaTypes(a)).not.toThrow()
  })
})

describe("pairFunctionCalls", () => {
  test("pairs FIFO when responses have no ids", () => {
    const contents: Array<Content> = [
      {
        role: "model",
        parts: [{ functionCall: { name: "f", args: { i: 1 } } }, { functionCall: { name: "f", args: { i: 2 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "f", response: { i: 1 } } }, { functionResponse: { name: "f", response: { i: 2 } } }],
      },
    ]
    const pairing = pairFunctionCalls(contents)
    const callParts = contents[0].parts ?? []
    const respParts = contents[1].parts ?? []
    const id0 = resolveCallId(callParts[0], pairing)
    const id1 = resolveCallId(callParts[1], pairing)
    expect(id0).toBeTruthy()
    expect(id1).toBeTruthy()
    expect(id0).not.toBe(id1)
    expect(resolveResponseId(respParts[0], pairing)).toBe(id0)
    expect(resolveResponseId(respParts[1], pairing)).toBe(id1)
  })

  test("explicit ids take precedence over FIFO regardless of document order", () => {
    const contents: Array<Content> = [
      {
        role: "model",
        parts: [{ functionCall: { id: "x", name: "f", args: {} } }, { functionCall: { name: "f", args: {} } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "f", response: {} } }, // id-less → should match the synth (second call)
          { functionResponse: { id: "x", name: "f", response: {} } }, // explicit → must match "x"
        ],
      },
    ]
    const pairing = pairFunctionCalls(contents)
    const callParts = contents[0].parts ?? []
    const respParts = contents[1].parts ?? []
    const synthId = resolveCallId(callParts[1], pairing)
    // The reservation pass removes "x" from the queue BEFORE the FIFO drain
    // runs, so the id-less response cannot steal "x" — it falls through to
    // the synth id of the second call. Each response now maps to a DISTINCT
    // callId, preserving 1:1 tool_call_id semantics for OpenAI upstream.
    expect(resolveResponseId(respParts[0], pairing)).toBe(synthId)
    expect(resolveResponseId(respParts[1], pairing)).toBe("x")
    expect(synthId).toBeTruthy()
    expect(synthId).not.toBe("x")
  })

  test("synthetic ids use the reserved __synth__: prefix that real clients cannot collide with", () => {
    // M-new-2: synthetic ids must be structurally distinguishable from any
    // explicit id a real client could send. Even if a deliberately-crafted
    // client sent an explicit id sharing the prefix, the pairing layer
    // treats it as an explicit id (pass-2 reservation) — synthetic ids the
    // resolver MINTS are pass-1 only and use a counter the client cannot
    // observe, so the two paths cannot mint identical strings by accident.
    const explicitWithPrefix = `${SYNTHETIC_CALL_ID_PREFIX}client-supplied:f`
    const contents: Array<Content> = [
      {
        role: "model",
        parts: [{ functionCall: { name: "f", args: { i: 1 } } }, { functionCall: { id: explicitWithPrefix, name: "f", args: { i: 2 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "f", response: { i: 1 } } }, { functionResponse: { id: explicitWithPrefix, name: "f", response: { i: 2 } } }],
      },
    ]
    const pairing = pairFunctionCalls(contents)
    const callParts = contents[0].parts ?? []
    const respParts = contents[1].parts ?? []
    const synthId = resolveCallId(callParts[0], pairing)
    const explicitId = resolveCallId(callParts[1], pairing)

    // Synth id mints with a counter + name suffix the client cannot see, so
    // even a deliberately-crafted explicit id sharing the prefix lands in a
    // distinct namespace; the two cannot collide structurally.
    expect(synthId?.startsWith(SYNTHETIC_CALL_ID_PREFIX)).toBe(true)
    expect(explicitId).toBe(explicitWithPrefix)
    expect(synthId).not.toBe(explicitId)
    expect(resolveResponseId(respParts[0], pairing)).toBe(synthId)
    expect(resolveResponseId(respParts[1], pairing)).toBe(explicitWithPrefix)
  })
})

describe("translateOpenAIStreamToGemini", () => {
  async function collect(source: AsyncIterable<{ frame: ServerSentEventMessage }>): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    for await (const step of source) {
      if (step.frame.data) out.push(JSON.parse(step.frame.data) as Record<string, unknown>)
    }
    return out
  }

  function mockStream(events: Array<unknown>): AsyncIterable<ServerSentEventMessage> {
    return (async function* () {
      for (const ev of events) {
        yield { data: JSON.stringify(ev) } as ServerSentEventMessage
      }
      yield { data: "[DONE]" } as ServerSentEventMessage
    })()
  }

  test("emits text frames per chunk then a final usage frame", async () => {
    const frames = await collect(
      translateOpenAIStreamToGemini(
        mockStream([
          {
            id: "1",
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: "Hello" } }],
          },
          {
            id: "1",
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
        ]),
        "gpt-4o",
      ),
    )

    // 2 text frames + 1 final
    expect(frames).toHaveLength(3)
    const finalFrame = frames[2] as {
      candidates: Array<{ finishReason: string; content: { parts: Array<unknown> } }>
      usageMetadata: { promptTokenCount: number }
    }
    expect(finalFrame.candidates[0].finishReason).toBe("STOP")
    // Terminal frame must NOT carry content parts — only finish + usage.
    expect(finalFrame.candidates[0].content.parts).toEqual([])
    expect(finalFrame.usageMetadata.promptTokenCount).toBe(3)
  })

  test("emits one functionCall frame on finish_reason='tool_calls' then a terminal frame", async () => {
    const frames = await collect(
      translateOpenAIStreamToGemini(
        mockStream([
          {
            id: "1",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":' } }],
                },
              },
            ],
          },
          {
            id: "1",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
          },
        ]),
        "gpt-4o",
      ),
    )
    // 1 functionCall frame + 1 terminal frame = 2 total (no text frames).
    expect(frames).toHaveLength(2)

    const toolFrame = frames[0] as {
      candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string; args: unknown } }> } }>
    }
    const call = toolFrame.candidates[0].content.parts[0].functionCall
    expect(call?.name).toBe("lookup")
    expect(call?.args).toEqual({ q: "x" })

    const terminal = frames[1] as {
      candidates: Array<{ finishReason: string; content: { parts: Array<unknown> } }>
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number }
    }
    expect(terminal.candidates[0].finishReason).toBe("STOP")
    expect(terminal.candidates[0].content.parts).toEqual([])
    expect(terminal.usageMetadata.candidatesTokenCount).toBe(8)
  })

  test("emits two separate functionCall frames for multi-tool calls", async () => {
    const frames = await collect(
      translateOpenAIStreamToGemini(
        mockStream([
          {
            id: "1",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
                    { index: 1, id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]),
        "gpt-4o",
      ),
    )
    // 2 functionCall frames + 1 terminal frame.
    expect(frames).toHaveLength(3)
    const f0 = frames[0] as { candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string } }> } }> }
    const f1 = frames[1] as { candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string } }> } }> }
    expect(f0.candidates[0].content.parts[0].functionCall?.name).toBe("a")
    expect(f1.candidates[0].content.parts[0].functionCall?.name).toBe("b")
  })

  test("fallback flush (no tool_calls finish_reason) emits one frame per tool call", async () => {
    // M-new-1: upstream omits finish_reason="tool_calls". The translator's
    // fallback drain at end-of-stream must still emit ONE frame per tool call
    // (matching the primary path and real Gemini wire behaviour) rather than
    // coalescing every call into a single frame.
    const frames = await collect(
      translateOpenAIStreamToGemini(
        mockStream([
          {
            id: "1",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
                    { index: 1, id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
                  ],
                },
                // NOTE: no finish_reason at all — fallback path must fire.
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]),
        "gpt-4o",
      ),
    )
    // 2 functionCall frames (one per call) + 1 terminal frame
    expect(frames).toHaveLength(3)
    const f0 = frames[0] as { candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string } }> } }> }
    const f1 = frames[1] as { candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string } }> } }> }
    expect(f0.candidates[0].content.parts).toHaveLength(1)
    expect(f1.candidates[0].content.parts).toHaveLength(1)
    expect(f0.candidates[0].content.parts[0].functionCall?.name).toBe("a")
    expect(f1.candidates[0].content.parts[0].functionCall?.name).toBe("b")
  })

  test("yields meta with usage + finishReason on the terminal step (and partial usage on earlier steps once observed)", async () => {
    const steps: Array<{ meta?: { usageMetadata?: { promptTokenCount?: number }; finishReason?: string } }> = []
    for await (const step of translateOpenAIStreamToGemini(
      mockStream([
        {
          id: "1",
          model: "gpt-4o",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      ]),
      "gpt-4o",
    )) {
      steps.push(step)
    }
    // Text step DOES carry meta — usage was surfaced on the same chunk, so the
    // translator forwards a partial snapshot so a mid-stream failure does not
    // discard the last-known usage (L-new-2).
    expect(steps[0].meta?.usageMetadata?.promptTokenCount).toBe(5)
    // Terminal step still carries the fully-built meta with finishReason.
    expect(steps.at(-1)?.meta?.usageMetadata?.promptTokenCount).toBe(5)
    expect(steps.at(-1)?.meta?.finishReason).toBe("STOP")
  })
})

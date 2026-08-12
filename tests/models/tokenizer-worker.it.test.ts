/**
 * The tokenizer Worker: the counting must move off the main thread WITHOUT moving the numbers.
 *
 * Both halves are load-bearing and neither implies the other. Equality alone was already true before the Worker existed, and a responsive main thread would be trivially satisfied by returning a wrong number instantly.
 *
 * `.it` rather than `.unit` because these spawn a real `node:worker_threads` Worker — the thing under test IS the thread boundary, so faking it would test nothing.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import { threadId } from "node:worker_threads"

import type { Model } from "~/lib/models/client"
import type {
  //
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"

import {
  //
  _resetTokenizerClient,
  getTokenizerWorkerDiagnostics,
  setTokenizerWorkerUrlForTests,
} from "~/lib/models/tokenizer-client"
import {
  //
  computePerMessageTokenCounts,
  computeTextTokens,
  computeTokenCount,
  computeToolsTokenCount,
} from "~/lib/models/tokenizer-core"
import {
  //
  countTextTokens,
  getPerMessageTokenCounts,
  getTokenCount,
  getToolsTokenCount,
} from "~/lib/models/tokenizer"

const model = { id: "claude-sonnet-4", capabilities: { tokenizer: "o200k_base" } } as unknown as Model

const messages = [
  { role: "user", content: "hello world" },
  { role: "assistant", content: "hi, how can I help?" },
  { role: "user", content: [{ type: "text", text: "some longer content ".repeat(200) }] },
] as unknown as Array<Message>

const payload = {
  model: "claude-sonnet-4",
  messages,
  tools: [{ type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path" } } } } }],
} as unknown as ChatCompletionsPayload

afterEach(async () => {
  await _resetTokenizerClient()
})

describe("the tokenizer Worker produces the same numbers as this thread", () => {
  test("all four public entry points agree with the in-thread computation", async () => {
    expect(await countTextTokens("the quick brown fox ".repeat(500), model)).toBe(await computeTextTokens("the quick brown fox ".repeat(500), model))
    expect(await getTokenCount(payload, model)).toEqual(await computeTokenCount(payload, model))
    expect(await getPerMessageTokenCounts(messages, model)).toEqual(await computePerMessageTokenCounts(messages, model))
    expect(await getToolsTokenCount(payload, model)).toBe(await computeToolsTokenCount(payload, model))
  }, 30_000)
})

describe("the counting actually happens off the main thread", () => {
  test("the answer comes back from another thread", async () => {
    await countTextTokens("hello world", model)

    const diagnostics = getTokenizerWorkerDiagnostics()
    // `node:worker_threads` numbers the main thread 0, so this is a deterministic oracle rather than a timing one: if the counting is ever moved back in-thread, the id can only be 0.
    // `threadId` is read here so the comparison is against the thread this test runs on, not against a hardcoded literal.
    expect(diagnostics.lastComputeThreadId).not.toBe(threadId)
    expect(diagnostics.lastComputeThreadId).toBeGreaterThan(0)
    expect(diagnostics.alive).toBe(true)
    expect(diagnostics.permanentFallback).toBe(false)
  }, 30_000)

  test("the event loop keeps running while a large payload is counted", async () => {
    // ~1.9MB of ordinary English. Runs of one repeated character are short-circuited (`run-collapse.ts`), so plain text is the honest remaining cost — measured at ~200ms in-thread, during which the loop is not slow but STOPPED.
    const text = "the quick brown fox jumps over the lazy dog ".repeat(46_000)
    await countTextTokens("warm up the worker and its encoder", model)

    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 5)
    const tokens = await countTextTokens(text, model)
    clearInterval(timer)

    expect(tokens).toBeGreaterThan(0)
    // Measured: 31 ticks through the Worker, and exactly 0 in-thread — a blocked event loop cannot fire a timer at all, so the bound discriminates the regression by a wide margin instead of by a wall-clock threshold.
    // It is deliberately an order of magnitude below the observed value: this asserts "the loop ran", not "how fast".
    expect(ticks).toBeGreaterThanOrEqual(3)
  }, 60_000)
})

describe("a Worker that cannot be had degrades to this thread, never to a wrong answer", () => {
  test("counting still returns the right number when the Worker entry does not exist", async () => {
    setTokenizerWorkerUrlForTests("./no-such-tokenizer-worker.ts")

    const text = "fallback path ".repeat(100)
    expect(await countTextTokens(text, model)).toBe(await computeTextTokens(text, model))
    expect(await getTokenCount(payload, model)).toEqual(await computeTokenCount(payload, model))
  }, 30_000)
})

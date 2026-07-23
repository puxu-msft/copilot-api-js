import { expect, test } from "bun:test"

import { classifyMaxTokensTruncation } from "~/lib/pipeline/max-tokens-truncation-class"
import { createTerminalObserver } from "~/lib/pipeline/max-tokens-terminal-observer"

test("A: a closed text block is classified as text", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "text", lastBlockClosed: true })).toBe("text")
})

test("A': an open text block is still classified as text", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "text", lastBlockClosed: false })).toBe("text")
})

test("B: an open tool_use block is classified as tool_use", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "tool_use", lastBlockClosed: false })).toBe("tool_use")
})

test("B-closed: a closed tool_use block is classified separately as tool_use_closed", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "tool_use", lastBlockClosed: true })).toBe("tool_use_closed")
})

test("C: thinking classification ignores closure state", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "thinking", lastBlockClosed: true })).toBe("thinking")
  expect(classifyMaxTokensTruncation({ lastBlockKind: "thinking", lastBlockClosed: false })).toBe("thinking")
})

test("no rendered block is not classifiable", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: undefined, lastBlockClosed: false })).toBeUndefined()
})

test("thinking observed after text stays thinking rather than falling back to the ledger-compatible text prefix", () => {
  const observer = createTerminalObserver()
  observer.lastBlockKind = "thinking"
  observer.lastBlockClosed = false

  expect(classifyMaxTokensTruncation(observer)).toBe("thinking")
})

import { expect, test } from "bun:test"

import { createTerminalObserver, updateAnthropicTerminalObserver } from "~/lib/pipeline/max-tokens-terminal-observer"

test("A': text block_start then delta then cut without content_block_stop records an open text block", () => {
  const observer = createTerminalObserver()

  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 0, content_block: { type: "text" } })
  updateAnthropicTerminalObserver(observer, { type: "content_block_delta", index: 0 })

  expect(observer).toEqual({ lastBlockKind: "text", lastBlockClosed: false })
})

test("zero-delta B: tool_use block_start followed by an immediate cut records an open tool_use block", () => {
  const observer = createTerminalObserver()

  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 0, content_block: { type: "tool_use" } })

  expect(observer).toEqual({ lastBlockKind: "tool_use", lastBlockClosed: false })
})

test("B-closed: tool_use block_stop closes the most recently observed tool_use block", () => {
  const observer = createTerminalObserver()

  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 0, content_block: { type: "tool_use" } })
  updateAnthropicTerminalObserver(observer, { type: "content_block_delta", index: 0 })
  updateAnthropicTerminalObserver(observer, { type: "content_block_stop", index: 0 })

  expect(observer).toEqual({ lastBlockKind: "tool_use", lastBlockClosed: true })
})

test("thinking after a closed text block replaces text as the last wire block", () => {
  const observer = createTerminalObserver()

  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 0, content_block: { type: "text" } })
  updateAnthropicTerminalObserver(observer, { type: "content_block_delta", index: 0 })
  updateAnthropicTerminalObserver(observer, { type: "content_block_stop", index: 0 })
  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 1, content_block: { type: "thinking" } })
  updateAnthropicTerminalObserver(observer, { type: "content_block_delta", index: 1 })

  expect(observer).toEqual({ lastBlockKind: "thinking", lastBlockClosed: false })
})

test("a stale content_block_stop cannot close a newer last wire block", () => {
  const observer = createTerminalObserver()

  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 0, content_block: { type: "text" } })
  updateAnthropicTerminalObserver(observer, { type: "content_block_start", index: 1, content_block: { type: "thinking" } })
  updateAnthropicTerminalObserver(observer, { type: "content_block_stop", index: 0 })

  expect(observer).toEqual({ lastBlockKind: "thinking", lastBlockClosed: false })
})

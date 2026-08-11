import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ResponsesFunctionCallOutput,
  ResponsesMessageOutput,
  ResponsesOutputItem,
} from "~/types/api/openai-responses"

import { isTerminalSnapshotComplete } from "~/lib/codec/openai-responses/buffered-merge-reducer"

const fc: ResponsesFunctionCallOutput = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "get_weather",
  arguments: '{"city":"Tokyo"}',
  status: "completed",
}
const msg: ResponsesMessageOutput = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hi", annotations: [] }],
}

describe("isTerminalSnapshotComplete", () => {
  test("complete when output matches collected exactly", () => {
    const collected = new Map([[0, fc]])
    expect(isTerminalSnapshotComplete([fc], collected)).toEqual({ complete: true })
  })
  test("empty-output: output is empty but items were collected", () => {
    const collected = new Map([[0, fc]])
    expect(isTerminalSnapshotComplete([], collected)).toEqual({ complete: false, reason: "empty-output" })
  })
  test("missing-item: an id in collected has no counterpart in output", () => {
    const collected = new Map<number, ResponsesOutputItem>([
      [0, fc],
      [1, msg],
    ])
    expect(isTerminalSnapshotComplete([fc], collected)).toEqual({ complete: false, reason: "missing-item" })
  })
  test("inconsistent-item: same id, different function_call arguments", () => {
    const collected = new Map([[0, fc]])
    const staleFc: ResponsesFunctionCallOutput = { ...fc, arguments: '{"city":"Osaka"}' }
    expect(isTerminalSnapshotComplete([staleFc], collected)).toEqual({ complete: false, reason: "inconsistent-item" })
  })
  test("inconsistent-item: same id, different message content", () => {
    const collected = new Map([[0, msg]])
    const staleMsg: ResponsesMessageOutput = { ...msg, content: [{ type: "output_text", text: "stale", annotations: [] }] }
    expect(isTerminalSnapshotComplete([staleMsg], collected)).toEqual({ complete: false, reason: "inconsistent-item" })
  })
  test("no collected items and empty output → complete (nothing to repair, e.g. completed_output=upstream on a plain response)", () => {
    expect(isTerminalSnapshotComplete([], new Map())).toEqual({ complete: true })
  })
})

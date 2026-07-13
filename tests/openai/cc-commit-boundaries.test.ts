import { expect, test } from "bun:test"
import { ccCommitBoundaries } from "~/lib/openai/cc-commit-boundaries"

const f = (o: unknown) => ({ data: JSON.stringify(o) })

test("CC terminal-only: only upstream error is a frame-level boundary; deltas are not", () => {
  expect(ccCommitBoundaries(f({ error: { message: "overloaded" } }))).toBe(true)
  expect(ccCommitBoundaries(f({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }))).toBe(false)
  // finish_reason 落在最后 chunk 上——由 handler 的 sawMessageStop 读 acc.finishReason 判定终止提交，非谓词。
  expect(ccCommitBoundaries({ data: "[DONE]" })).toBe(false) // driver 丢弃 [DONE]，handler post-loop 合成
})

test("CC terminal-only: throw-safety — undefined/unparseable data never boundaries", () => {
  expect(ccCommitBoundaries({ data: undefined })).toBe(false)
  expect(ccCommitBoundaries({ data: "not json{" })).toBe(false)
})

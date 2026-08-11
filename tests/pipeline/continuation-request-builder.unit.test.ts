import {
  //
  expect,
  test,
} from "bun:test"

import type { ContinuationRequestBuilder } from "~/lib/pipeline/continuation-request-builder"

import {
  //
  getContinuationBuilder,
  registerContinuationBuilder,
} from "~/lib/pipeline/continuation-request-builder"

test("unregistered format returns undefined (caller degrades to partial-degrade)", () => {
  expect(getContinuationBuilder("gemini")).toBeUndefined()
})

test("a registered builder is retrievable by format", () => {
  const builder: ContinuationRequestBuilder = (_orig, committed, message) => ({ n: committed.length, message })
  registerContinuationBuilder("openai-cc", builder)
  expect(getContinuationBuilder("openai-cc")).toBe(builder)
})

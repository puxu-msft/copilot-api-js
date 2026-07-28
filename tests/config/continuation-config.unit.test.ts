import {
  //
  expect,
  test,
} from "bun:test"

import { resolveContinuation } from "~/lib/config/model-overrides"
import { BufferedRetryOverrideSchema } from "~/lib/config/schema"
import {
  //
  setBufferedRetryContinuationOverride,
  setBufferedRetryContinuationShared,
} from "~/lib/state"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

useIsolatedRuntime()

test("schema parses the continuation block on a buffered_retry map", () => {
  const parsed = BufferedRetryOverrideSchema.parse({ continuation: { enabled: false, message: "retry now" } })
  expect(parsed.continuation).toEqual({ enabled: false, message: "retry now" })
})

test("schema rejects unknown continuation keys (strict)", () => {
  expect(() => BufferedRetryOverrideSchema.parse({ continuation: { bogus: 1 } })).toThrow()
})

test("continuation defaults: enabled true, default message", () => {
  const c = resolveContinuation("anthropic")
  expect(c.enabled).toBe(true)
  expect(c.message).toBe("network issue. please continue")
})

test("shared override applies to all vendors", () => {
  setBufferedRetryContinuationShared({ message: "please continue" })
  expect(resolveContinuation("openai-responses").message).toBe("please continue")
  expect(resolveContinuation("chat_completions").message).toBe("please continue")
})

test("per-vendor override wins over shared and default", () => {
  setBufferedRetryContinuationShared({ enabled: true, message: "shared" })
  setBufferedRetryContinuationOverride("anthropic", { message: "vendor" })
  expect(resolveContinuation("anthropic").message).toBe("vendor")
  expect(resolveContinuation("anthropic").enabled).toBe(true)
  // a vendor without its own override still gets the shared value
  expect(resolveContinuation("openai-responses").message).toBe("shared")
})

test("per-vendor enabled=false disables continuation for that vendor only", () => {
  setBufferedRetryContinuationOverride("chat_completions", { enabled: false })
  expect(resolveContinuation("chat_completions").enabled).toBe(false)
  expect(resolveContinuation("anthropic").enabled).toBe(true)
})

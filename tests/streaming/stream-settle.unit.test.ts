import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"

import { settleStreamingFailure } from "~/lib/request/stream-settle"
import {
  //
  StreamClientAbortError,
  StreamIdleTimeoutError,
  StreamShutdownError,
} from "~/lib/stream"

/** Minimal RequestContext stub recording abort()/fail() calls. */
function makeReqCtxStub() {
  const calls: Array<{ kind: "abort" | "fail"; model: string; error?: unknown; partial?: unknown }> = []
  const reqCtx = {
    abort(model: string, partial?: unknown) {
      calls.push({ kind: "abort", model, partial })
    },
    fail(model: string, error: unknown, partial?: unknown) {
      calls.push({ kind: "fail", model, error, partial })
    },
  } as unknown as RequestContext
  return { reqCtx, calls }
}

describe("settleStreamingFailure — unified terminal-settle decision", () => {
  test("client disconnect → abort() and returns true (caller must not write a frame)", () => {
    const { reqCtx, calls } = makeReqCtxStub()
    const partial = { usage: { input_tokens: 7, output_tokens: 3 } }

    const isClientAbort = settleStreamingFailure({ reqCtx, error: new StreamClientAbortError(), model: "m", partial })

    expect(isClientAbort).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: "abort", model: "m", partial })
  })

  test("shutdown → fail() (NOT abort) and returns false", () => {
    const { reqCtx, calls } = makeReqCtxStub()
    const err = new StreamShutdownError()

    const isClientAbort = settleStreamingFailure({ reqCtx, error: err, model: "m" })

    expect(isClientAbort).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: "fail", model: "m", error: err })
  })

  test("idle-timeout / generic errors → fail() and returns false", () => {
    for (const err of [new StreamIdleTimeoutError(300_000), new Error("upstream boom")]) {
      const { reqCtx, calls } = makeReqCtxStub()
      const isClientAbort = settleStreamingFailure({ reqCtx, error: err, model: "m" })
      expect(isClientAbort).toBe(false)
      expect(calls[0]?.kind).toBe("fail")
    }
  })

  test("passes partial usage through to both abort and fail", () => {
    const partial = { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }

    const a = makeReqCtxStub()
    settleStreamingFailure({ reqCtx: a.reqCtx, error: new StreamClientAbortError(), model: "m", partial })
    expect(a.calls[0]?.partial).toBe(partial)

    const f = makeReqCtxStub()
    settleStreamingFailure({ reqCtx: f.reqCtx, error: new Error("x"), model: "m", partial })
    expect(f.calls[0]?.partial).toBe(partial)
  })
})

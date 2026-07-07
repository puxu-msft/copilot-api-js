import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import { HTTPError } from "~/lib/error"
import { createReactiveRejectionStrategy } from "~/lib/request/strategies/reactive-rejection"

interface P {
  model: string
  [k: string]: unknown
}

const ctx: RetryContext<P> = { attempt: 0, maxRetries: 3, originalPayload: { model: "m" }, model: undefined }

function err(body: string): ApiError {
  return { type: "bad_request", status: 400, message: "HTTP 400", raw: new HTTPError("boom", 400, body, "m") }
}

function make(overrides?: Partial<Parameters<typeof createReactiveRejectionStrategy<P>>[0]>) {
  const marks: Array<[string, string]> = []
  const strategy = createReactiveRejectionStrategy<P>({
    name: "test-reactive",
    match: (e) => (e.raw instanceof HTTPError && e.raw.responseText.includes("TOKEN") ? "cap-x" : null),
    mark: (model, token) => marks.push([model, token]),
    remediate: ({ payload, token }) => ({ action: "retry", payload, meta: { token } }),
    ...overrides,
  })
  return { strategy, marks }
}

describe("createReactiveRejectionStrategy", () => {
  test("name is passed through", () => {
    expect(make().strategy.name).toBe("test-reactive")
  })

  test("canHandle: true only for 400 bad_request whose match() is non-null", () => {
    const { strategy } = make()
    expect(strategy.canHandle(err("has TOKEN here"))).toBe(true)
    expect(strategy.canHandle(err("unrelated"))).toBe(false)
    expect(strategy.canHandle({ ...err("has TOKEN"), status: 500, type: "server_error" })).toBe(false)
  })

  test("handle: marks (model, token) then remediates", async () => {
    const { strategy, marks } = make()
    const res = await strategy.handle(err("TOKEN"), { model: "claude-x" }, ctx)
    expect(res.action).toBe("retry")
    expect(marks).toEqual([["claude-x", "cap-x"]])
    expect((res as unknown as { meta: { token: string } }).meta.token).toBe("cap-x")
  })

  test("one-shot: canHandle false after one handle", async () => {
    const { strategy } = make()
    await strategy.handle(err("TOKEN"), { model: "m" }, ctx)
    expect(strategy.canHandle(err("TOKEN"))).toBe(false)
  })

  test("handle aborts when match() returns null at handle time (defensive)", async () => {
    const { strategy } = make({ match: () => null })
    const res = await strategy.handle(err("TOKEN"), { model: "m" }, ctx)
    expect(res.action).toBe("abort")
  })
})

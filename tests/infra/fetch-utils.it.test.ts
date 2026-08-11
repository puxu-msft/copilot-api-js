import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  captureHttpHeaders,
  createUpstreamFirstEventTimeoutSignal,
  sanitizeHeadersForHistory,
} from "~/lib/fetch-utils"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

describe("sanitizeHeadersForHistory", () => {
  test("masks sensitive request headers while preserving other headers", () => {
    expect(
      sanitizeHeadersForHistory({
        Authorization: "Bearer secret",
        "proxy-authorization": "Basic abc",
        "x-api-key": "shh",
        "content-type": "application/json",
      }),
    ).toEqual({
      Authorization: "***",
      "proxy-authorization": "***",
      "x-api-key": "***",
      "content-type": "application/json",
    })
  })
})

describe("createUpstreamFirstEventTimeoutSignal", () => {
  test("returns undefined when fetch timeout is disabled", () => {
    setStateForTests({ responseHeaderTimeout: 0 })

    expect(createUpstreamFirstEventTimeoutSignal()).toBeUndefined()
  })

  test("returns an abort signal when fetch timeout is configured", () => {
    setStateForTests({ responseHeaderTimeout: 1 })

    const signal = createUpstreamFirstEventTimeoutSignal()

    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
  })

  test("per-model override wins over a disabled scalar", () => {
    // scalar disabled (0) but the model has an override → a signal is produced.
    setStateForTests({ responseHeaderTimeout: 0, responseHeaderTimeoutOverrides: { "gpt-5.5": 5 } })

    expect(createUpstreamFirstEventTimeoutSignal("gpt-5.5")).toBeDefined()
    // A non-matching model falls back to the (disabled) scalar → undefined.
    expect(createUpstreamFirstEventTimeoutSignal("gpt-4.1")).toBeUndefined()
  })

  test("per-model override of 0 disables even when the scalar is set", () => {
    setStateForTests({ responseHeaderTimeout: 1, responseHeaderTimeoutOverrides: { "gpt-5.5": 0 } })

    expect(createUpstreamFirstEventTimeoutSignal("gpt-5.5")).toBeUndefined()
  })

  test("undefined model uses the scalar (no-arg behavior unchanged)", () => {
    setStateForTests({ responseHeaderTimeout: 1, responseHeaderTimeoutOverrides: { "gpt-5.5": 5 } })

    expect(createUpstreamFirstEventTimeoutSignal()).toBeDefined()
  })
})

describe("captureHttpHeaders", () => {
  test("captures raw request and response headers (Phase 1: History stores unredacted)", () => {
    const capture: {
      request?: Record<string, string>
      response?: Record<string, string>
    } = {}

    captureHttpHeaders(
      capture,
      {
        Authorization: "Bearer secret",
        "content-type": "application/json",
      },
      new Response("ok", {
        status: 200,
        headers: { "x-request-id": "abc123" },
      }),
    )

    expect(capture.request).toEqual({
      Authorization: "Bearer secret",
      "content-type": "application/json",
    })
    expect(capture.response).toEqual({
      "x-request-id": "abc123",
    })
  })
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  captureHttpHeaders,
  createResponseHeaderTimeoutSignal,
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

describe("createResponseHeaderTimeoutSignal", () => {
  test("returns undefined when fetch timeout is disabled", () => {
    setStateForTests({ responseHeaderTimeout: 0 })

    expect(createResponseHeaderTimeoutSignal()).toBeUndefined()
  })

  test("returns an abort signal when fetch timeout is configured", () => {
    setStateForTests({ responseHeaderTimeout: 1 })

    const signal = createResponseHeaderTimeoutSignal()

    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
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

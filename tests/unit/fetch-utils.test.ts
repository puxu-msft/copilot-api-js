import { afterEach, describe, expect, test } from "bun:test"

import { captureHttpHeaders, createFetchSignal, sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalState = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(originalState)
})

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

describe("createFetchSignal", () => {
  test("returns undefined when fetch timeout is disabled", () => {
    setStateForTests({ fetchTimeout: 0 })

    expect(createFetchSignal()).toBeUndefined()
  })

  test("returns an abort signal when fetch timeout is configured", () => {
    setStateForTests({ fetchTimeout: 1 })

    const signal = createFetchSignal()

    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
  })
})

describe("captureHttpHeaders", () => {
  test("captures sanitized request headers and raw response headers", () => {
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
      Authorization: "***",
      "content-type": "application/json",
    })
    expect(capture.response).toEqual({
      "x-request-id": "abc123",
    })
  })
})

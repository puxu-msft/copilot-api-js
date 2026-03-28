import { describe, expect, test } from "bun:test"

import { sanitizeHeadersForHistory } from "~/lib/fetch-utils"

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

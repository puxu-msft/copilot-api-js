import { describe, expect, test } from "bun:test"

import { extractInputItems } from "~/routes/responses/pipeline"

describe("extractInputItems", () => {
  test("wraps string input as a synthetic user message item", () => {
    expect(extractInputItems("Hello world")).toEqual([{ type: "message", role: "user", content: "Hello world" }])
  })

  test("passes through array input items unchanged", () => {
    const input = [
      { type: "message", role: "user", content: "hello" },
      { type: "function_call", id: "fc_1", call_id: "fc_1", name: "search", arguments: "{}" },
    ]

    expect(extractInputItems(input as Array<any>)).toEqual(input)
  })
})

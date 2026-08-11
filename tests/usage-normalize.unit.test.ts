import {
  //
  expect,
  test,
} from "bun:test"

import { usageFromTotalInput } from "~/lib/request/usage-normalize"

test("usageFromTotalInput subtracts cache_write (as cacheCreation) from input (subset branch)", () => {
  // prompt=1000, cached=600, cache_write=300 → net input = 100
  const u = usageFromTotalInput({ totalInput: 1000, output: 50, cacheRead: 600, cacheCreation: 300, reasoning: 10 })
  expect(u.input_tokens).toBe(100)
  expect(u.cache_read_input_tokens).toBe(600)
  expect(u.cache_creation_input_tokens).toBe(300)
  expect(u.output_tokens_details?.reasoning_tokens).toBe(10)
})

test("usageFromTotalInput omits cache_creation when zero + attaches details when present", () => {
  const u = usageFromTotalInput({
    totalInput: 100,
    output: 5,
    cacheRead: 0,
    cacheCreation: 0,
    inputDetails: { image: 12 },
    outputDetails: { accepted_prediction_tokens: 3 },
  })
  expect(u.cache_creation_input_tokens).toBeUndefined()
  expect(u.input_tokens_details?.image).toBe(12)
  expect(u.output_tokens_details?.accepted_prediction_tokens).toBe(3)
})

test("usageFromTotalInput merges reasoning into outputDetails and prunes empty", () => {
  // reasoning + prediction coexist under output_tokens_details
  const both = usageFromTotalInput({ totalInput: 10, output: 2, reasoning: 7, outputDetails: { rejected_prediction_tokens: 1 } })
  expect(both.output_tokens_details).toEqual({ reasoning_tokens: 7, rejected_prediction_tokens: 1 })

  // all-empty details → the key is omitted entirely (non-empty-only convention)
  const none = usageFromTotalInput({ totalInput: 10, output: 2, inputDetails: {}, outputDetails: {} })
  expect(none.input_tokens_details).toBeUndefined()
  expect(none.output_tokens_details).toBeUndefined()
})

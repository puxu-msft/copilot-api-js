import {
  //
  expect,
  test,
} from "bun:test"

import { nonNegOrUndef } from "~/types/api/ghc-usage"

test("nonNegOrUndef filters null/NaN/negative, keeps non-negative finite", () => {
  expect(nonNegOrUndef(5)).toBe(5)
  expect(nonNegOrUndef(0)).toBe(0)
  expect(nonNegOrUndef(null)).toBeUndefined()
  expect(nonNegOrUndef(undefined)).toBeUndefined()
  expect(nonNegOrUndef(-1)).toBeUndefined()
  expect(nonNegOrUndef(Number.NaN)).toBeUndefined()
  expect(nonNegOrUndef(Number.POSITIVE_INFINITY)).toBeUndefined()
})

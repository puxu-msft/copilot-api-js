import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { resolveRouterBase } from "../src/utils/router-base"

describe("router base", () => {
  test("resolves router base from Vite BASE_URL and falls back to root", () => {
    expect(resolveRouterBase("/ui/")).toBe("/ui/")
    expect(resolveRouterBase("/")).toBe("/")
    expect(resolveRouterBase("")).toBe("/")
  })
})

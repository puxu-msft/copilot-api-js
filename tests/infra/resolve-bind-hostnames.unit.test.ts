import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { resolveBindHostnames } from "~/start"

describe("resolveBindHostnames", () => {
  test("defaults undefined to dual-stack loopback", () => {
    expect(resolveBindHostnames(undefined)).toEqual({
      hostnames: ["127.0.0.1", "::1"],
      displayHost: "localhost",
    })
  })

  test("'localhost' expands to dual-stack loopback", () => {
    expect(resolveBindHostnames("localhost")).toEqual({
      hostnames: ["127.0.0.1", "::1"],
      displayHost: "localhost",
    })
  })

  test("'any' expands to dual-stack wildcard", () => {
    expect(resolveBindHostnames("any")).toEqual({
      hostnames: ["0.0.0.0", "::"],
      displayHost: "0.0.0.0",
    })
  })

  test("explicit IPv4 address binds only that address", () => {
    expect(resolveBindHostnames("127.0.0.1")).toEqual({
      hostnames: ["127.0.0.1"],
      displayHost: "127.0.0.1",
    })
  })

  test("explicit 0.0.0.0 stays single-stack (not expanded to dual)", () => {
    expect(resolveBindHostnames("0.0.0.0")).toEqual({
      hostnames: ["0.0.0.0"],
      displayHost: "0.0.0.0",
    })
  })

  test("explicit IPv6 address binds only that address", () => {
    expect(resolveBindHostnames("::1")).toEqual({
      hostnames: ["::1"],
      displayHost: "::1",
    })
  })

  test("explicit hostname binds only that hostname", () => {
    expect(resolveBindHostnames("api.example.com")).toEqual({
      hostnames: ["api.example.com"],
      displayHost: "api.example.com",
    })
  })
})

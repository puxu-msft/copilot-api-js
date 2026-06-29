import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  filterUpstreamQuery,
  UPSTREAM_QUERY_EXCLUDE,
} from "~/lib/transport/query-forward"

describe("filterUpstreamQuery", () => {
  describe("empty / no query", () => {
    test("empty string returns empty", () => {
      expect(filterUpstreamQuery("")).toBe("")
    })

    test("bare question mark returns empty", () => {
      expect(filterUpstreamQuery("?")).toBe("")
    })
  })

  describe("non-sensitive keys pass through", () => {
    test("?beta=true is preserved", () => {
      expect(filterUpstreamQuery("?beta=true")).toBe("?beta=true")
    })

    test("input without leading ? is accepted", () => {
      expect(filterUpstreamQuery("beta=true")).toBe("?beta=true")
    })

    test("multiple non-sensitive keys keep order", () => {
      expect(filterUpstreamQuery("?a=1&b=2&c=3")).toBe("?a=1&b=2&c=3")
    })

    test("repeated keys are all kept", () => {
      expect(filterUpstreamQuery("?beta=1&beta=2")).toBe("?beta=1&beta=2")
    })
  })

  describe("built-in excludes are stripped (auth / conflict)", () => {
    test("api-version removed", () => {
      expect(filterUpstreamQuery("?api-version=2024-10-21")).toBe("")
    })

    test("key removed", () => {
      expect(filterUpstreamQuery("?key=secret")).toBe("")
    })

    test("access_token removed", () => {
      expect(filterUpstreamQuery("?access_token=tok")).toBe("")
    })

    test("alt removed", () => {
      expect(filterUpstreamQuery("?alt=sse")).toBe("")
    })

    test("mixed: only non-sensitive survive", () => {
      expect(filterUpstreamQuery("?beta=1&api-version=2&key=3&access_token=4&alt=sse&x=9")).toBe("?beta=1&x=9")
    })
  })

  describe("exclude match is case-insensitive on the key name", () => {
    test("API-VERSION removed", () => {
      expect(filterUpstreamQuery("?API-VERSION=x")).toBe("")
    })

    test("Key removed", () => {
      expect(filterUpstreamQuery("?Key=s")).toBe("")
    })
  })

  describe("extraExclude unions with the built-in set", () => {
    test("extra key stripped, others kept", () => {
      expect(filterUpstreamQuery("?foo=1&bar=2", ["foo"])).toBe("?bar=2")
    })

    test("extra is case-insensitive", () => {
      expect(filterUpstreamQuery("?Foo=1&bar=2", ["foo"])).toBe("?bar=2")
    })

    test("built-in excludes still apply alongside extra", () => {
      expect(filterUpstreamQuery("?key=1&foo=2&beta=3", ["foo"])).toBe("?beta=3")
    })
  })

  describe("built-in exclude set", () => {
    test("contains the auth + conflict keys", () => {
      expect(UPSTREAM_QUERY_EXCLUDE.has("api-version")).toBe(true)
      expect(UPSTREAM_QUERY_EXCLUDE.has("key")).toBe(true)
      expect(UPSTREAM_QUERY_EXCLUDE.has("access_token")).toBe(true)
      expect(UPSTREAM_QUERY_EXCLUDE.has("alt")).toBe(true)
    })
  })
})

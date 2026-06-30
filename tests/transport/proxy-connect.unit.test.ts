import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  buildSocksProxy,
  connectProxiedSocket,
  proxyAuthHeader,
} from "~/lib/transport/proxy-connect"

// Real tunnel round-trips (CONNECT / SOCKS5 through a live proxy) are left to
// out-of-band verification, matching the project convention for proxy paths
// (see tests/infra/proxy.unit.test.ts). These cover the pure, synchronous logic.

describe("connectProxiedSocket — scheme dispatch", () => {
  test("rejects an unsupported proxy scheme before connecting", async () => {
    await expect(
      connectProxiedSocket({ targetHost: "api.anthropic.com", targetPort: 443, proxyUrl: "ftp://proxy.example:21", timeoutMs: 1000 }),
    ).rejects.toThrow("Unsupported proxy protocol: ftp: Supported: http, https, socks5, socks5h")
  })
})

describe("buildSocksProxy", () => {
  test("builds a SOCKS5 proxy descriptor with default port 1080", () => {
    expect(buildSocksProxy(new URL("socks5://proxy.example"))).toEqual({
      host: "proxy.example",
      port: 1080,
      type: 5,
    })
  })

  test("uses the explicit port when present", () => {
    expect(buildSocksProxy(new URL("socks5h://proxy.example:9050")).port).toBe(9050)
  })

  test("decodes URL credentials into userId/password", () => {
    const proxy = buildSocksProxy(new URL("socks5://al%40ice:p%40ss@proxy.example:1080"))
    expect(proxy.userId).toBe("al@ice")
    expect(proxy.password).toBe("p@ss")
  })

  test("omits password when only a username is present", () => {
    const proxy = buildSocksProxy(new URL("socks5://alice@proxy.example:1080"))
    expect(proxy.userId).toBe("alice")
    expect(proxy.password).toBeUndefined()
  })
})

describe("proxyAuthHeader", () => {
  test("returns an empty object when the URL has no credentials", () => {
    expect(proxyAuthHeader(new URL("http://proxy.example:8080"))).toEqual({})
  })

  test("builds a Basic Proxy-Authorization header from credentials", () => {
    const header = proxyAuthHeader(new URL("http://alice:secret@proxy.example:8080"))
    expect(header["proxy-authorization"]).toBe(`Basic ${Buffer.from("alice:secret").toString("base64")}`)
  })

  test("decodes percent-encoded credentials before encoding", () => {
    const header = proxyAuthHeader(new URL("http://al%40ice:p%40ss@proxy.example:8080"))
    expect(header["proxy-authorization"]).toBe(`Basic ${Buffer.from("al@ice:p@ss").toString("base64")}`)
  })
})

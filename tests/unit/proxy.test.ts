import { afterEach, describe, expect, test } from "bun:test"

import { Agent, ProxyAgent } from "undici"

import { createDispatcherForUrl, formatProxyDisplay, initProxy } from "~/lib/proxy"

const originalHttpProxy = process.env.HTTP_PROXY
const originalHttpsProxy = process.env.HTTPS_PROXY

describe("proxy utilities", () => {
  afterEach(() => {
    process.env.HTTP_PROXY = originalHttpProxy
    process.env.HTTPS_PROXY = originalHttpsProxy
  })

  test("formatProxyDisplay strips credentials from proxy URLs", () => {
    expect(formatProxyDisplay("http://alice:secret@example.com:8080")).toBe("http://alice:***@example.com:8080")
  })

  test("formatProxyDisplay returns raw input for invalid URLs", () => {
    expect(formatProxyDisplay("not a url")).toBe("not a url")
  })

  test("createDispatcherForUrl returns a ProxyAgent for HTTP and HTTPS proxies", () => {
    expect(createDispatcherForUrl("http://proxy.example:8080")).toBeInstanceOf(ProxyAgent)
    expect(createDispatcherForUrl("https://proxy.example:8443")).toBeInstanceOf(ProxyAgent)
  })

  test("createDispatcherForUrl returns an Agent for SOCKS5 proxies", () => {
    expect(createDispatcherForUrl("socks5://proxy.example:1080")).toBeInstanceOf(Agent)
    expect(createDispatcherForUrl("socks5h://user:pass@proxy.example:1080")).toBeInstanceOf(Agent)
  })

  test("createDispatcherForUrl rejects unsupported protocols", () => {
    expect(() => createDispatcherForUrl("ftp://proxy.example")).toThrow(
      "Unsupported proxy protocol: ftp:. Supported: http, https, socks5, socks5h",
    )
  })

  test("initProxy configures Bun HTTP proxy environment variables", () => {
    process.env.HTTP_PROXY = ""
    process.env.HTTPS_PROXY = ""

    initProxy({
      url: "http://proxy.example:8080",
      fromEnv: false,
    })

    expect(process.env.HTTP_PROXY).toBe("http://proxy.example:8080")
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.example:8080")
  })

  test("initProxy leaves Bun proxy environment untouched when no explicit URL is provided", () => {
    process.env.HTTP_PROXY = "http://existing-proxy:8080"
    process.env.HTTPS_PROXY = "http://existing-proxy:8080"

    initProxy({
      fromEnv: true,
    })

    expect(process.env.HTTP_PROXY).toBe("http://existing-proxy:8080")
    expect(process.env.HTTPS_PROXY).toBe("http://existing-proxy:8080")
  })

  test("initProxy rejects SOCKS5 proxies on Bun runtime", () => {
    expect(() =>
      initProxy({
        url: "socks5://proxy.example:1080",
        fromEnv: false,
      }),
    ).toThrow("SOCKS5 proxy is not supported on Bun runtime. Use Node.js or an HTTP proxy instead.")
  })
})

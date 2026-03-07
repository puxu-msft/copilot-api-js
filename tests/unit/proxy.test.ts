import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Agent, ProxyAgent } from "undici"

import { createDispatcherForUrl, formatProxyDisplay, initProxy } from "~/lib/proxy"

// ============================================================================
// formatProxyDisplay
// ============================================================================

describe("formatProxyDisplay", () => {
  test("should strip password from HTTP URL", () => {
    expect(formatProxyDisplay("http://user:secret@proxy.example.com:8080")).toBe(
      "http://user:***@proxy.example.com:8080",
    )
  })

  test("should strip password from SOCKS5h URL", () => {
    expect(formatProxyDisplay("socks5h://admin:p%40ss@10.0.0.1:1080")).toBe("socks5h://admin:***@10.0.0.1:1080")
  })

  test("should preserve URL without credentials", () => {
    expect(formatProxyDisplay("http://proxy.example.com:7890")).toBe("http://proxy.example.com:7890")
  })

  test("should preserve socks5 URL without credentials", () => {
    expect(formatProxyDisplay("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080")
  })

  test("should return raw string for invalid URL", () => {
    expect(formatProxyDisplay("not-a-url")).toBe("not-a-url")
  })

  test("should handle username without password", () => {
    expect(formatProxyDisplay("http://user@proxy.example.com:8080")).toBe("http://user:***@proxy.example.com:8080")
  })
})

// ============================================================================
// createDispatcherForUrl — protocol dispatch logic (runtime-agnostic)
// ============================================================================

describe("createDispatcherForUrl", () => {
  test("should return ProxyAgent for http:// URL", () => {
    const dispatcher = createDispatcherForUrl("http://127.0.0.1:7890")
    expect(dispatcher).toBeInstanceOf(ProxyAgent)
  })

  test("should return ProxyAgent for https:// URL", () => {
    const dispatcher = createDispatcherForUrl("https://proxy.example.com:443")
    expect(dispatcher).toBeInstanceOf(ProxyAgent)
  })

  test("should return Agent (SOCKS) for socks5:// URL", () => {
    const dispatcher = createDispatcherForUrl("socks5://127.0.0.1:1080")
    expect(dispatcher).toBeInstanceOf(Agent)
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent)
  })

  test("should return Agent (SOCKS) for socks5h:// URL", () => {
    const dispatcher = createDispatcherForUrl("socks5h://127.0.0.1:1080")
    expect(dispatcher).toBeInstanceOf(Agent)
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent)
  })

  test("should return Agent (SOCKS) for socks5h:// with auth", () => {
    const dispatcher = createDispatcherForUrl("socks5h://user:pass@127.0.0.1:1080")
    expect(dispatcher).toBeInstanceOf(Agent)
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent)
  })

  test("should throw for unsupported protocol", () => {
    expect(() => createDispatcherForUrl("ftp://proxy.example.com")).toThrow(/Unsupported proxy protocol.*ftp/)
  })

  test("should throw for invalid URL", () => {
    expect(() => createDispatcherForUrl("not-a-url")).toThrow()
  })
})

// ============================================================================
// initProxy — Bun runtime path (these tests run in Bun)
// ============================================================================

describe("initProxy (Bun path)", () => {
  let savedHttpProxy: string | undefined
  let savedHttpsProxy: string | undefined

  beforeEach(() => {
    savedHttpProxy = process.env.HTTP_PROXY
    savedHttpsProxy = process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
  })

  afterEach(() => {
    // Restore env vars
    if (savedHttpProxy !== undefined) process.env.HTTP_PROXY = savedHttpProxy
    else delete process.env.HTTP_PROXY
    if (savedHttpsProxy !== undefined) process.env.HTTPS_PROXY = savedHttpsProxy
    else delete process.env.HTTPS_PROXY
  })

  test("should set HTTP_PROXY and HTTPS_PROXY env vars for http:// URL", () => {
    initProxy({ url: "http://127.0.0.1:7890", fromEnv: false })
    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890")
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
  })

  test("should set env vars for https:// URL", () => {
    initProxy({ url: "https://proxy.example.com:443", fromEnv: false })
    expect(process.env.HTTP_PROXY).toBe("https://proxy.example.com:443")
    expect(process.env.HTTPS_PROXY).toBe("https://proxy.example.com:443")
  })

  test("should throw for socks5:// on Bun", () => {
    expect(() => initProxy({ url: "socks5://127.0.0.1:1080", fromEnv: false })).toThrow(
      /SOCKS5 proxy is not supported on Bun/,
    )
  })

  test("should throw for socks5h:// on Bun", () => {
    expect(() => initProxy({ url: "socks5h://127.0.0.1:1080", fromEnv: false })).toThrow(
      /SOCKS5 proxy is not supported on Bun/,
    )
  })

  test("should not modify env vars when no URL and fromEnv is false", () => {
    initProxy({ url: undefined, fromEnv: false })
    expect(process.env.HTTP_PROXY).toBeUndefined()
    expect(process.env.HTTPS_PROXY).toBeUndefined()
  })

  test("should not modify env vars when no URL and fromEnv is true", () => {
    // fromEnv without explicit URL — Bun path does nothing (Bun reads env natively)
    initProxy({ url: undefined, fromEnv: true })
    expect(process.env.HTTP_PROXY).toBeUndefined()
    expect(process.env.HTTPS_PROXY).toBeUndefined()
  })
})

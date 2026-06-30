import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  Agent,
  ProxyAgent,
} from "undici/index.js"

import {
  //
  createDispatcherForUrl,
  formatProxyDisplay,
  getProxyUrlForOrigin,
  getUpstreamDispatcher,
  getUpstreamKeepAliveDelayMs,
  initProxy,
} from "~/lib/proxy"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

const originalHttpProxy = process.env.HTTP_PROXY
const originalHttpsProxy = process.env.HTTPS_PROXY
const originalNoProxy = process.env.NO_PROXY

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
    expect(() => createDispatcherForUrl("ftp://proxy.example")).toThrow("Unsupported proxy protocol: ftp:. Supported: http, https, socks5, socks5h")
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

  test("initProxy accepts SOCKS5 on Bun without exporting it to env (honored for https via node:http2)", () => {
    process.env.HTTP_PROXY = ""
    process.env.HTTPS_PROXY = ""

    expect(() => initProxy({ url: "socks5://proxy.example:1080", fromEnv: false })).not.toThrow()

    // Bun's native fetch does not understand socks5 — it must NOT be exported to env vars.
    expect(process.env.HTTP_PROXY).toBe("")
    expect(process.env.HTTPS_PROXY).toBe("")
    // But it IS resolvable for https upstreams via the h2 tunnel resolver.
    expect(getProxyUrlForOrigin(new URL("https://api.anthropic.com"))).toBe("socks5://proxy.example:1080")
  })
})

describe("getProxyUrlForOrigin", () => {
  afterEach(() => {
    process.env.HTTP_PROXY = originalHttpProxy
    process.env.HTTPS_PROXY = originalHttpsProxy
    process.env.NO_PROXY = originalNoProxy
    // Reset cachedProxyOptions to a no-proxy baseline so config doesn't leak between suites.
    initProxy({ fromEnv: false })
  })

  test("an explicit proxy URL applies to every origin", () => {
    initProxy({ url: "http://proxy.example:8080", fromEnv: false })
    expect(getProxyUrlForOrigin(new URL("https://api.anthropic.com"))).toBe("http://proxy.example:8080")
    expect(getProxyUrlForOrigin(new URL("https://api.githubcopilot.com/v1"))).toBe("http://proxy.example:8080")
  })

  test("env mode resolves per-origin and honors NO_PROXY", () => {
    process.env.HTTP_PROXY = "http://env-proxy:3128"
    process.env.HTTPS_PROXY = "http://env-proxy:3128"
    process.env.NO_PROXY = "api.githubcopilot.com"
    initProxy({ fromEnv: true })

    expect(getProxyUrlForOrigin(new URL("https://api.anthropic.com"))).toBe("http://env-proxy:3128")
    expect(getProxyUrlForOrigin(new URL("https://api.githubcopilot.com"))).toBeUndefined()
  })

  test("returns undefined when no proxy is configured", () => {
    initProxy({ fromEnv: false })
    expect(getProxyUrlForOrigin(new URL("https://api.anthropic.com"))).toBeUndefined()
  })
})

describe("getUpstreamDispatcher", () => {
  afterEach(() => {
    process.env.HTTP_PROXY = originalHttpProxy
    process.env.HTTPS_PROXY = originalHttpsProxy
  })

  test("returns a ProxyAgent after initProxy with an explicit HTTP proxy URL", () => {
    initProxy({ url: "http://proxy.example:8080", fromEnv: false })
    expect(getUpstreamDispatcher()).toBeInstanceOf(ProxyAgent)
  })

  test("returns an Agent-based dispatcher when configured from environment", () => {
    // EnvProxyDispatcher extends Agent; assert via the public base type.
    initProxy({ fromEnv: true })
    expect(getUpstreamDispatcher()).toBeInstanceOf(Agent)
  })

  test("returns a configured Agent when no proxy is set", () => {
    initProxy({ fromEnv: false })
    const dispatcher = getUpstreamDispatcher()
    expect(dispatcher).toBeInstanceOf(Agent)
    // A plain Agent, not the ProxyAgent variant.
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent)
  })
})

describe("getUpstreamKeepAliveDelayMs", () => {
  autoRestoreState()

  test("converts a positive delay (seconds) to milliseconds", () => {
    setStateForTests({ upstreamKeepaliveDelay: 15 })
    expect(getUpstreamKeepAliveDelayMs()).toBe(15_000)
  })

  test("returns undefined for 0 (use undici's built-in default)", () => {
    setStateForTests({ upstreamKeepaliveDelay: 0 })
    expect(getUpstreamKeepAliveDelayMs()).toBeUndefined()
  })

  test("rounds up sub-second / fractional delays", () => {
    setStateForTests({ upstreamKeepaliveDelay: 0.5 })
    expect(getUpstreamKeepAliveDelayMs()).toBe(500)
  })
})

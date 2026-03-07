/**
 * Proxy configuration: HTTP/HTTPS and SOCKS5/5h proxy support.
 *
 * Priority: explicit proxy URL (CLI --proxy or config.yaml) > env vars (--http-proxy-from-env).
 * On Node.js, proxying works via undici's global dispatcher.
 * On Bun, HTTP proxies are set via env vars (Bun handles them natively); SOCKS5 is not supported.
 */

import consola from "consola"
import tls from "node:tls"
import { getProxyForUrl } from "proxy-from-env"
import { SocksClient, type SocksProxy } from "socks"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

// ============================================================================
// Public API
// ============================================================================

export interface ProxyOptions {
  /** Explicit proxy URL (from CLI --proxy or config.yaml proxy) */
  url?: string
  /** Fall back to HTTP_PROXY/HTTPS_PROXY environment variables */
  fromEnv: boolean
}

/**
 * Initialize proxy for all outgoing fetch requests.
 *
 * On Node.js: sets undici's global dispatcher.
 * On Bun: sets process.env.HTTP_PROXY/HTTPS_PROXY for HTTP proxies (Bun handles natively).
 *
 * Must be called before any network requests.
 */
export function initProxy(options: ProxyOptions): void {
  if (typeof Bun !== "undefined") {
    initProxyBun(options)
    return
  }

  initProxyNode(options)
}

/** Format a proxy URL for display (strip credentials) */
export function formatProxyDisplay(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl)
    const auth = u.username ? `${u.username}:***@` : ""
    return `${u.protocol}//${auth}${u.host}`
  } catch {
    return proxyUrl
  }
}

// ============================================================================
// Node.js implementation (undici dispatchers)
// ============================================================================

function initProxyNode(options: ProxyOptions): void {
  try {
    if (options.url) {
      const dispatcher = createDispatcherForUrl(options.url)
      setGlobalDispatcher(dispatcher)
      consola.debug(`Proxy configured: ${formatProxyDisplay(options.url)}`)
      return
    }

    if (options.fromEnv) {
      const dispatcher = new EnvProxyDispatcher()
      setGlobalDispatcher(dispatcher)
      consola.debug("HTTP proxy configured from environment (per-URL)")
    }
  } catch (err) {
    consola.error("Proxy setup failed:", err)
    throw err
  }
}

/** Create the appropriate undici dispatcher for a proxy URL scheme */
export function createDispatcherForUrl(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl)
  const protocol = url.protocol.toLowerCase()

  if (protocol === "http:" || protocol === "https:") {
    return new ProxyAgent(proxyUrl)
  }

  if (protocol === "socks5:" || protocol === "socks5h:") {
    return createSocksAgent(url)
  }

  throw new Error(`Unsupported proxy protocol: ${protocol}. Supported: http, https, socks5, socks5h`)
}

// ============================================================================
// SOCKS5/5h agent
// ============================================================================

/**
 * Create an undici Agent that routes connections through a SOCKS5/5h proxy.
 *
 * For socks5h:// the proxy performs DNS resolution (hostname passed as-is).
 * For socks5:// the hostname is also passed to the proxy (proxy resolves).
 * Both protocols support username/password authentication via URL credentials.
 */
function createSocksAgent(proxyUrl: URL): Agent {
  const proxy: SocksProxy = {
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port) || 1080,
    type: 5,
  }

  // Support username/password authentication
  if (proxyUrl.username) {
    proxy.userId = decodeURIComponent(proxyUrl.username)
    proxy.password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
  }

  return new Agent({
    connect(opts, callback) {
      const destPort = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80)

      SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: {
          host: opts.hostname,
          port: destPort,
        },
      })
        .then(({ socket }) => {
          if (opts.protocol === "https:") {
            // Upgrade to TLS for HTTPS destinations
            const tlsSocket = tls.connect({
              socket,
              servername: opts.servername ?? opts.hostname,
            })
            callback(null, tlsSocket)
          } else {
            callback(null, socket)
          }
        })
        .catch((err: unknown) => {
          callback(err instanceof Error ? err : new Error(String(err)), null)
        })
    },
  })
}

// ============================================================================
// Environment variable proxy dispatcher (existing behavior)
// ============================================================================

/**
 * Custom dispatcher that routes requests through proxies based on environment variables.
 * Uses proxy-from-env to resolve HTTP_PROXY/HTTPS_PROXY/NO_PROXY per-URL.
 */
class EnvProxyDispatcher extends Agent {
  private proxies = new Map<string, ProxyAgent>()

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    try {
      const origin = this.getOriginUrl(options.origin)
      const proxyUrl = this.getProxyUrl(origin)

      if (!proxyUrl) {
        consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
        return super.dispatch(options, handler)
      }

      const agent = this.getOrCreateProxyAgent(proxyUrl)
      consola.debug(`HTTP proxy route: ${origin.hostname} via ${formatProxyDisplay(proxyUrl)}`)
      return agent.dispatch(options, handler)
    } catch {
      return super.dispatch(options, handler)
    }
  }

  private getOriginUrl(origin: Dispatcher.DispatchOptions["origin"]): URL {
    return typeof origin === "string" ? new URL(origin) : (origin as URL)
  }

  private getProxyUrl(origin: URL): string | undefined {
    const raw = getProxyForUrl(origin.toString())
    return raw && raw.length > 0 ? raw : undefined
  }

  private getOrCreateProxyAgent(proxyUrl: string): ProxyAgent {
    let agent = this.proxies.get(proxyUrl)
    if (!agent) {
      agent = new ProxyAgent(proxyUrl)
      this.proxies.set(proxyUrl, agent)
    }
    return agent
  }

  override async close(): Promise<void> {
    await super.close()
    await Promise.all([...this.proxies.values()].map((p) => p.close()))
    this.proxies.clear()
  }

  override destroy(err?: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    // Clean up proxy agents (fire-and-forget, errors are ignored)
    for (const agent of this.proxies.values()) {
      if (typeof errOrCallback === "function") {
        agent.destroy(errOrCallback)
      } else if (callback) {
        agent.destroy(errOrCallback ?? null, callback)
      } else {
        agent.destroy(errOrCallback ?? null).catch(() => {
          // Ignore cleanup errors
        })
      }
    }
    this.proxies.clear()

    // Call super with appropriate overload
    if (typeof errOrCallback === "function") {
      super.destroy(errOrCallback)
      return
    } else if (callback) {
      super.destroy(errOrCallback ?? null, callback)
      return
    } else {
      return super.destroy(errOrCallback ?? null)
    }
  }
}

// ============================================================================
// Bun implementation
// ============================================================================

/**
 * Initialize proxy for Bun runtime.
 * Bun handles HTTP_PROXY/HTTPS_PROXY env vars natively.
 * SOCKS5 proxies are not supported on Bun.
 */
function initProxyBun(options: ProxyOptions): void {
  if (!options.url) return

  const url = new URL(options.url)
  const protocol = url.protocol.toLowerCase()

  if (protocol === "socks5:" || protocol === "socks5h:") {
    throw new Error("SOCKS5 proxy is not supported on Bun runtime. Use Node.js or an HTTP proxy instead.")
  }

  // Set env vars for Bun's native HTTP proxy support
  process.env.HTTP_PROXY = options.url
  process.env.HTTPS_PROXY = options.url
  consola.debug(`Proxy configured (Bun env): ${formatProxyDisplay(options.url)}`)
}

/**
 * Proxy configuration: HTTP/HTTPS and SOCKS5/5h proxy support.
 *
 * Priority: explicit proxy URL (CLI --proxy) > env vars (--http-proxy-from-env) > config.yaml proxy.
 *
 * This module drives the undici dispatcher, which now serves ONLY plaintext
 * `http://` upstreams (local SearXNG) — every `https://` upstream goes through
 * node:http2 (transport/http2-client.ts), which honors proxy config via
 * {@link getProxyUrlForOrigin} + transport/proxy-connect.ts (CONNECT / SOCKS5
 * tunnel), on BOTH Bun and Node. On Bun the undici dispatcher is not consumed by
 * the global fetch, so a SOCKS5 proxy only reaches https upstreams (h2 path), not
 * the plaintext SearXNG path.
 */

import consola from "consola"
import tls from "node:tls"
import { getProxyForUrl } from "proxy-from-env"
import { SocksClient } from "socks"
// undici via file subpath (not bare "undici"): Bun shims the bare specifier and
// drops the dispatcher's keepalive. The subpath loads the real undici. The Agent
// built here must be the SAME undici instance the dispatcher is fed to in
// transport/upstream-fetch.ts, so both import from "undici/index.js".
import {
  //
  Agent,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici/index.js"

import {
  //
  onRequestWatchdogChange,
  onUpstreamTransportChange,
  state,
} from "./state"
import { buildSocksProxy } from "./transport/proxy-connect"

// ============================================================================
// Undici timeout configuration
// ============================================================================

/**
 * Multiplier applied to application-level timeouts when configuring undici's
 * transport-level timeouts. Ensures undici does not fire before our own
 * `streamIdleTimeout` / `responseHeaderTimeout` watchdogs, so timeout errors surface
 * through the application layer with proper context.
 */
const UNDICI_TIMEOUT_MULTIPLIER = 1.5

/**
 * Convert an application timeout in seconds (0 = disabled) to undici's
 * milliseconds (0 = disabled), applying the safety multiplier.
 */
function scaleTimeout(seconds: number): number {
  if (seconds <= 0) return 0
  return Math.ceil(seconds * UNDICI_TIMEOUT_MULTIPLIER * 1000)
}

/**
 * Upstream TCP keepalive initial-probe delay in milliseconds.
 *
 * Derived from `state.upstreamKeepaliveDelay` (seconds). Returns `undefined`
 * when 0 (use undici's built-in default of 60s). Lowering this below the path's
 * idle-reaper window (NAT/firewall/LB, commonly ~30s) keeps the GHC connection
 * alive through long upstream silences — e.g. opus adaptive thinking that goes
 * quiet for tens of seconds after `content_block_start`. undici's 60s default
 * is too long: the first probe never fires before a ~30s reaper culls the idle
 * socket, surfacing as `terminated (cause: other side closed)`.
 */
export function getUpstreamKeepAliveDelayMs(): number | undefined {
  const sec = state.upstreamKeepaliveDelay
  return sec > 0 ? Math.ceil(sec * 1000) : undefined
}

/**
 * Upstream HTTP/2 PING keepalive interval in milliseconds (0 = disabled).
 *
 * Derived from `state.upstreamH2PingInterval` (seconds). The application-layer
 * complement to the TCP keepalive above: GHC's CAPI proxy does NOT forward
 * Anthropic's SSE `event: ping` frames, so a long thinking silence is a truly
 * idle upstream stream (verified via the upstream-original sseEvents track: a
 * real request saw content for ~3s, then 112s of total wire silence, then the
 * stream was closed WITHOUT `message_stop`). TCP keepalive keeps L4 alive
 * through NAT but does not defeat a connection-idle reaper (middlebox or GHC
 * edge) counting application-layer silence — periodic h2 PING puts real frames
 * on the wire. Consumed by http2-client.ts:scheduleH2KeepalivePing. Works on
 * both Bun and Node (node:http2 transport is runtime-neutral); the plaintext
 * undici path has no long silences.
 */
export function getUpstreamH2PingIntervalMs(): number {
  const sec = state.upstreamH2PingInterval
  return sec > 0 ? Math.ceil(sec * 1000) : 0
}

/**
 * Build undici Agent options from current runtime state.
 *
 * - `headersTimeout` follows `responseHeaderTimeout` (time to first response headers)
 * - `bodyTimeout`    follows `streamIdleTimeout` (gap between body chunks)
 * - `connect.keepAliveInitialDelay` follows `upstreamKeepaliveDelay` (TCP probe)
 */
function getUndiciAgentOptions(): Agent.Options {
  const keepAliveInitialDelay = getUpstreamKeepAliveDelayMs()
  return {
    headersTimeout: scaleTimeout(state.responseHeaderTimeout),
    bodyTimeout: scaleTimeout(state.streamIdleTimeout),
    ...(keepAliveInitialDelay !== undefined && { connect: { keepAlive: true, keepAliveInitialDelay } }),
  }
}

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
    cachedProxyOptions = options
    const dispatcher = buildUpstreamDispatcher(options)
    currentUpstreamDispatcher = dispatcher
    setGlobalDispatcher(dispatcher)
    logDispatcherInstalled(options)
    ensureTimeoutSubscription()
  } catch (err) {
    consola.error("Proxy setup failed:", err)
    throw err
  }
}

/** Cached proxy options so timeout hot-reload can rebuild the same dispatcher type. */
let cachedProxyOptions: ProxyOptions | null = null
/**
 * The dispatcher currently serving upstream requests, returned by
 * {@link getUpstreamDispatcher}. On Node this mirrors the global dispatcher; on
 * Bun it is the ONLY way to apply our Agent options (timeouts + TCP keepalive),
 * since Bun's global fetch does not consume `setGlobalDispatcher`.
 */
let currentUpstreamDispatcher: Dispatcher | undefined
let timeoutSubscriptionInstalled = false

/**
 * The dispatcher that upstream `undiciFetch` calls must pass explicitly. Lazily
 * falls back to a timeout/keepalive-configured Agent when `initProxy()` has not
 * run yet (e.g. CLI tools / tests that issue an upstream request directly).
 */
export function getUpstreamDispatcher(): Dispatcher {
  if (!currentUpstreamDispatcher) currentUpstreamDispatcher = new Agent(getUndiciAgentOptions())
  return currentUpstreamDispatcher
}

/**
 * Resolve the proxy URL to use for a given upstream origin, honoring the same
 * priority as {@link buildUpstreamDispatcher}: explicit `--proxy`/config URL wins
 * for all origins, else env vars (NO_PROXY-aware, per-origin), else none.
 *
 * Consumed by the node:http2 transport (transport/http2-client.ts), which speaks
 * h2 directly and therefore cannot use the undici dispatcher. Returns `undefined`
 * when no proxy applies (direct connection) or before `initProxy()` has run.
 */
export function getProxyUrlForOrigin(origin: URL): string | undefined {
  if (!cachedProxyOptions) return undefined
  if (cachedProxyOptions.url) return cachedProxyOptions.url
  if (cachedProxyOptions.fromEnv) {
    const raw = getProxyForUrl(origin.toString())
    return raw && raw.length > 0 ? raw : undefined
  }
  return undefined
}

/** Build the dispatcher serving upstream requests for the given proxy options. */
function buildUpstreamDispatcher(options: ProxyOptions): Dispatcher {
  if (options.url) return createDispatcherForUrl(options.url)
  if (options.fromEnv) return new EnvProxyDispatcher()
  // No proxy: still use a configured Agent so undici's default 300s headers/body
  // timeouts do not pre-empt our application-level streamIdleTimeout / responseHeaderTimeout.
  return new Agent(getUndiciAgentOptions())
}

/** Emit the install-time debug line matching the chosen dispatcher kind. */
function logDispatcherInstalled(options: ProxyOptions): void {
  if (options.url) {
    consola.debug(`Proxy configured: ${formatProxyDisplay(options.url)}`)
  } else if (options.fromEnv) {
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } else {
    consola.debug(`Undici timeouts: headers=${state.responseHeaderTimeout}s body=${state.streamIdleTimeout}s (x${UNDICI_TIMEOUT_MULTIPLIER})`)
  }
}

/** Subscribe once to timeout/keepalive hot-reload, rebuilding the cached dispatcher. */
function ensureTimeoutSubscription(): void {
  if (timeoutSubscriptionInstalled) return
  onRequestWatchdogChange(rebuildUpstreamDispatcher)
  onUpstreamTransportChange(rebuildUpstreamDispatcher)
  timeoutSubscriptionInstalled = true
}

/**
 * Rebuild the cached upstream dispatcher when responseHeaderTimeout / streamIdleTimeout /
 * upstreamKeepaliveDelay change. On Node the global dispatcher is replaced too;
 * the old one is left for in-flight requests to drain and GC. On Bun there is no
 * global dispatcher to replace — only the cached one matters.
 */
function rebuildUpstreamDispatcher(): void {
  if (!cachedProxyOptions) return
  try {
    const dispatcher = buildUpstreamDispatcher(cachedProxyOptions)
    currentUpstreamDispatcher = dispatcher
    if (typeof Bun === "undefined") setGlobalDispatcher(dispatcher)
    consola.debug(
      `Undici dispatcher reloaded: headers=${state.responseHeaderTimeout}s body=${state.streamIdleTimeout}s keepalive=${state.upstreamKeepaliveDelay}s`,
    )
  } catch (err) {
    consola.error("Undici dispatcher reload failed:", err)
  }
}

/** Create the appropriate undici dispatcher for a proxy URL scheme */
export function createDispatcherForUrl(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl)
  const protocol = url.protocol.toLowerCase()
  const timeouts = getUndiciAgentOptions()

  if (protocol === "http:" || protocol === "https:") {
    return new ProxyAgent({ uri: proxyUrl, ...timeouts })
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
  const proxy = buildSocksProxy(proxyUrl)

  return new Agent({
    // The spread's `connect` object is overridden by the explicit connector
    // below; keepalive is applied manually on the SOCKS-tunneled socket instead.
    ...getUndiciAgentOptions(),
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
          // NB: this SOCKS-tunneled socket (and the tls.connect below) is
          // deliberately NOT withErrorSink'd (cf. transport/crash-safety.ts): it is
          // handed straight to undici's `callback`, and undici owns it from there —
          // it attaches its own 'error' handling, so there is no no-listener window.
          // withErrorSink is only for sockets/sessions the transport itself owns
          // through a teardown/handoff gap (node:http2 path, proxy-connect.ts).
          // Apply the same TCP keepalive as the non-proxy path so middlebox idle
          // reapers don't sever the tunnel during long upstream silences. TLS
          // (below) wraps this same underlying socket, so setting it here covers
          // both HTTP and HTTPS destinations.
          const keepAliveDelayMs = getUpstreamKeepAliveDelayMs()
          if (keepAliveDelayMs !== undefined) socket.setKeepAlive(true, keepAliveDelayMs)

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
  private readonly timeoutOptions = getUndiciAgentOptions()

  constructor() {
    super(getUndiciAgentOptions())
  }

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
      agent = new ProxyAgent({ uri: proxyUrl, ...this.timeoutOptions })
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
 * SOCKS5 is supported on Bun for https upstreams via node:http2 (proxy-connect.ts)
 * and for plaintext http via the explicit undici dispatcher — no longer rejected.
 */
function initProxyBun(options: ProxyOptions): void {
  if (options.url) {
    const protocol = new URL(options.url).protocol.toLowerCase()
    const isSocks = protocol === "socks5:" || protocol === "socks5h:"

    // Bun's global fetch reads HTTP_PROXY/HTTPS_PROXY natively (residual
    // global-fetch callers). Do NOT export a socks5 URL there: Bun's native fetch
    // does not understand socks5, and the hot paths use the explicit dispatcher
    // (plaintext http) / node:http2 tunnel (https) instead.
    if (!isSocks) {
      process.env.HTTP_PROXY = options.url
      process.env.HTTPS_PROXY = options.url
    }
    consola.debug(`Proxy configured (Bun): ${formatProxyDisplay(options.url)}`)
  }

  // Bun ignores setGlobalDispatcher, so cache an explicit dispatcher carrying our
  // Agent options (timeouts + TCP keepalive). getUpstreamDispatcher() hands it to
  // undiciFetch on the plaintext-http hot path; https goes through node:http2,
  // which reads getProxyUrlForOrigin() directly for the proxy tunnel.
  cachedProxyOptions = options
  currentUpstreamDispatcher = buildUpstreamDispatcher(options)
  ensureTimeoutSubscription()
}

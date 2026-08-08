/**
 * Single entry point for all upstream HTTP requests.
 *
 * Wraps undici's `fetch` with the proxy/timeout/keepalive dispatcher from
 * {@link getUpstreamDispatcher}. undici (not Bun's global fetch) is required:
 * Bun's global fetch ignores `setGlobalDispatcher` and exposes no socket-keepalive
 * knob, so a long upstream silence (e.g. opus adaptive thinking after
 * `content_block_start`) gets the idle TCP connection reaped by a middlebox
 * (NAT/firewall/LB) and surfaces as `transport-close`. Routing every upstream
 * call through one undici dispatcher gives Bun and Node identical timeouts + TCP
 * keepalive.
 *
 * undici's Response is WHATWG-compatible; the cast bridges the nominal type gap
 * (lib.dom Response vs undici Response) once, here, so call sites stay clean.
 *
 * Tests inject a replacement via {@link setUpstreamFetchForTests} so the existing
 * `globalThis.fetch` mock harness keeps working without each suite re-plumbing to
 * undici's MockAgent. The undici integration itself (dispatcher carries keepalive)
 * is covered separately by the proxy unit tests + an out-of-band `ss` check.
 */

// Import undici via its file subpath "undici/index.js", NOT the bare "undici"
// specifier. Bun replaces the bare specifier with a built-in shim whose fetch
// silently ignores the `dispatcher` option (verified: a subclassed Agent's
// dispatch() is never called), so TCP keepalive never applies on Bun. The file
// subpath bypasses the shim and loads the real undici, making the dispatcher
// (and its keepalive) take effect on both Bun and Node — verified via `ss` that
// the upstream HTTPS socket carries a `timer:(keepalive,...)`. Pinned to undici 7:
// undici 8's index.js eagerly constructs CacheStorage and crashes on Bun 1.3.14.
// The subpath resolves only because undici ships NO `exports` field — if a future
// undici adds one that restricts subpaths, this breaks; the exact pin in
// package.json + the C1 regression test (upstream-fetch.unit.test.ts) guard it.
import { fetch as undiciFetch } from "undici/index.js"

import {
  //
  getUpstreamDispatcher,
  getUpstreamH2Favor,
} from "~/lib/proxy"
import { combineAbortSignals } from "~/lib/stream"

import { http2Fetch } from "./http2-client"
import { createResponseHeaderDeadline } from "./response-header-deadline"

/** Request init accepted by {@link upstreamFetch}; the dispatcher is added internally. */
export interface UpstreamFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal | undefined
  /** Maximum time to receive response headers. Disarmed as soon as the transport resolves. */
  responseHeaderTimeoutMs?: number
  /**
   * Best-effort HTTP/2 response-trailers callback. Invoked (h2 path only) when the
   * upstream sends a trailing HEADERS frame — fired AFTER the body's data frames and
   * BEFORE `end`, so a consumer that settles on stream end sees the trailers first.
   * The plain-`http` (undici) path does not surface trailers and never calls this.
   */
  onTrailers?: (trailers: Record<string, string>) => void
  /** HTTP/2-only physical stream close notification, after all local req callbacks are detached/fired. */
  onStreamClosed?: () => void
}

type UpstreamFetchFn = (url: string | URL, init: UpstreamFetchInit) => Promise<Response>

/** undici transport — used for plaintext `http://` upstreams (e.g. local SearXNG). */
const undiciUpstreamFetch: UpstreamFetchFn = (url, init) => undiciFetch(url, { ...init, dispatcher: getUpstreamDispatcher() }) as unknown as Promise<Response>

/**
 * Choose the transport for an upstream URL. Plaintext `http://` always uses
 * undici. `https://` prefers HTTP/2 unless `upstream_transport.http2.favor` is
 * disabled (see {@link getUpstreamH2Favor} + the `state.upstreamH2Favor` caveat:
 * `favor:false` falls back to undici, which hangs on GHC under Bun). Exported so
 * the routing decision is unit-testable without mocking the transports.
 */
export function selectUpstreamTransport(url: URL): "http2" | "undici" {
  if (url.protocol !== "https:") return "undici"
  return getUpstreamH2Favor() ? "http2" : "undici"
}

/**
 * Prefer HTTP/2 for every `https://` upstream (unless `favor` is disabled — see
 * {@link selectUpstreamTransport}). All real upstreams are h2-native (verified:
 * GHC `api.*.githubcopilot.com`, `api.github.com`, `github.com`,
 * `api.anthropic.com`), and undici's HTTP/1.1 parser hangs forever under Bun on
 * the Copilot hosts' chunked responses (see http2-client.ts / RFC). The only
 * plaintext `http://` upstream (local SearXNG) stays on undici.
 */
const productionUpstreamFetch: UpstreamFetchFn = (url, init) => {
  const u = typeof url === "string" ? new URL(url) : url
  return selectUpstreamTransport(u) === "http2" ? http2Fetch(u, init) : undiciUpstreamFetch(u, init)
}

let activeUpstreamFetch: UpstreamFetchFn = productionUpstreamFetch

/** Issue an upstream HTTP request — HTTP/2 for https, undici for plaintext http. */
export function upstreamFetch(url: string | URL, init: UpstreamFetchInit): Promise<Response> {
  const { responseHeaderTimeoutMs = 0, signal, ...transportInit } = init
  if (responseHeaderTimeoutMs <= 0) return activeUpstreamFetch(url, { ...transportInit, signal })

  const deadline = createResponseHeaderDeadline(responseHeaderTimeoutMs)
  try {
    return activeUpstreamFetch(url, {
      ...transportInit,
      signal: combineAbortSignals(signal, deadline.signal),
    }).finally(() => deadline.complete())
  } catch (error) {
    deadline.complete()
    throw error
  }
}

/**
 * Test-only: route {@link upstreamFetch} through `fn` (e.g. the `globalThis.fetch`
 * mock), or restore the production path when `fn` is undefined.
 */
export function setUpstreamFetchForTests(fn: UpstreamFetchFn | undefined): void {
  activeUpstreamFetch = fn ?? productionUpstreamFetch
}

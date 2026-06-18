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

import { getUpstreamDispatcher } from "~/lib/proxy"

/** Request init accepted by {@link upstreamFetch}; the dispatcher is added internally. */
export interface UpstreamFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal | undefined
}

type UpstreamFetchFn = (url: string | URL, init: UpstreamFetchInit) => Promise<Response>

const productionUpstreamFetch: UpstreamFetchFn = (url, init) =>
  undiciFetch(url, { ...init, dispatcher: getUpstreamDispatcher() }) as unknown as Promise<Response>

let activeUpstreamFetch: UpstreamFetchFn = productionUpstreamFetch

/** Issue an upstream HTTP request via undici with our keepalive/timeout dispatcher. */
export function upstreamFetch(url: string | URL, init: UpstreamFetchInit): Promise<Response> {
  return activeUpstreamFetch(url, init)
}

/**
 * Test-only: route {@link upstreamFetch} through `fn` (e.g. the `globalThis.fetch`
 * mock), or restore the production undici path when `fn` is undefined.
 */
export function setUpstreamFetchForTests(fn: UpstreamFetchFn | undefined): void {
  activeUpstreamFetch = fn ?? productionUpstreamFetch
}

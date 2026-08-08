/**
 * Shared `globalThis.fetch` mocking utilities for tests.
 *
 * Centralizes the boilerplate that was previously copy-pasted across a dozen
 * test files: capturing the real fetch at module load, restoring it after each
 * test, and casting a Bun `mock(...)` into `typeof fetch`. Using these helpers
 * keeps the `as unknown as typeof fetch` cast in exactly one place.
 *
 * Typical usage:
 *
 *   import { autoRestoreFetch, setFetchMock } from "../helpers/mock-fetch"
 *
 *   describe("my client", () => {
 *     autoRestoreFetch() // registers afterEach -> restoreFetch()
 *
 *     test("handles 200", async () => {
 *       const fetchMock = setFetchMock(() => new Response("{}", { status: 200 }))
 *       await callTheClient()
 *       expect(fetchMock).toHaveBeenCalledTimes(1)
 *     })
 *   })
 *
 * For a persistent mock reused across tests (set once in `beforeEach`), create
 * it with Bun's `mock()` and install it with `applyFetchMock`:
 *
 *   const upstream = mock(async (_input, init) => responseFactory(init))
 *   beforeEach(() => { upstream.mockClear(); applyFetchMock(upstream) })
 *
 * For passthrough (forward unmatched requests to the network), call `realFetch`
 * inside the handler:
 *
 *   setFetchMock((input, init) =>
 *     String(input).includes("/local") ? new Response("ok") : realFetch(input, init),
 *   )
 */

import {
  //
  afterEach,
  mock,
} from "bun:test"

import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

/** The real `fetch`, captured at module load before any test swaps it out. */
export const realFetch: typeof fetch = globalThis.fetch

/** Signature accepted by the fetch-mock helpers (a subset of `fetch`). */
export type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>

/**
 * Bridge `upstreamFetch` (transport/upstream-fetch.ts) to whatever is currently
 * installed as `globalThis.fetch`. Production code issues upstream requests via
 * undici + a dispatcher, bypassing `globalThis.fetch`; this routes those calls
 * back through the installed mock so the existing harness keeps working without
 * each suite re-plumbing to undici's MockAgent. Reads `globalThis.fetch` lazily
 * so a later `setFetchMock` swap is honoured.
 */
function installUpstreamBridge(): void {
  setUpstreamFetchForTests((url, init) => Promise.resolve(globalThis.fetch(url, init as RequestInit)))
}

/** Restore `globalThis.fetch` to the real implementation captured at load. */
export function restoreFetch(): void {
  globalThis.fetch = realFetch
  setUpstreamFetchForTests(undefined)
}

/**
 * Register an `afterEach` hook that restores the real fetch. Call once at the
 * top of a describe block (or module scope) so individual tests don't each
 * have to remember to restore.
 */
export function autoRestoreFetch(): void {
  afterEach(restoreFetch)
}

/**
 * Wrap `handler` in a Bun mock, install it as `globalThis.fetch`, and return
 * the mock so callers can assert on calls. The `typeof fetch` cast lives here
 * so test files stay free of `as unknown as typeof fetch`.
 */
export function setFetchMock(handler: FetchHandler) {
  const fetchMock = mock(handler)
  globalThis.fetch = fetchMock as unknown as typeof fetch
  installUpstreamBridge()
  return fetchMock
}

/**
 * Install an already-created mock (e.g. a module-level persistent mock reused
 * across tests) as `globalThis.fetch`, without re-wrapping it. Returns the same
 * mock for convenience.
 */
export function applyFetchMock<T extends (...args: Array<never>) => unknown>(fetchMock: T): T {
  globalThis.fetch = fetchMock as unknown as typeof fetch
  installUpstreamBridge()
  return fetchMock
}

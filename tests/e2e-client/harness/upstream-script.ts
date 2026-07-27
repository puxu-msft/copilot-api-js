export { createSseResponse, createSseResponseThenError } from "../../helpers/sse"

/** Build a non-streaming JSON upstream `Response` (status 200, `application/json`). Use for a
 *  non-streaming client call (`messages.create`) — the proxy forwards `stream:false` upstream and
 *  expects a JSON body (a streaming SSE body would make it JSON.parse `event: ...` → 500). */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

/** Build an HTTP-error upstream `Response` (status 4xx/5xx, JSON error body). Use to drive the
 *  client's HTTP-response error path (typed subclass + `.status` + auto-retry) — CONTRAST with a
 *  200+in-stream `event: error` (untyped APIError, no retry) — and to drive a reactive-retry leg's
 *  first attempt (proxy strips a field + retries internally). The body must be Anthropic error-shaped
 *  (`{type:"error", error:{type, message}}`) so both the SDK and the proxy's retry matchers see it. */
export function httpErrorResponse(status: number, error: { type: string; message: string }): Response {
  return new Response(JSON.stringify({ type: "error", error }), { status, headers: { "content-type": "application/json" } })
}

export interface ScriptedUpstream {
  /**
   * Feed to `setUpstreamFetchForTests`: every proxy→GHC call returns a fresh `makeResponse()`.
   * (A fresh Response per call — a `ReadableStream` body can only be consumed once, so retries /
   * multiple attempts each need their own.)
   */
  handler: (url: string | URL, init: RequestInit | undefined) => Promise<Response>
  /** How many times the proxy actually called upstream — the retry / no-retry oracle. */
  callCount: () => number
  /** Parsed bodies actually presented to the upstream mock, in dispatch order. */
  requestBodies: () => ReadonlyArray<unknown>
}

function parsedRequestBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}

/** Build a scripted upstream that counts proxy→GHC calls and returns `makeResponse()` each time. */
export function scriptedUpstream(makeResponse: () => Response): ScriptedUpstream {
  let calls = 0
  const bodies: Array<unknown> = []
  return {
    handler: (_url, init) => {
      bodies.push(parsedRequestBody(init))
      calls++
      return Promise.resolve(makeResponse())
    },
    callCount: () => calls,
    requestBodies: () => bodies,
  }
}

/**
 * Build a scripted upstream that returns a DIFFERENT response per call: `makers[0]` on the first
 * proxy→GHC call, `makers[1]` on the second, etc. The LAST maker repeats for any further calls. Use
 * to drive the proxy's internal reactive-retry legs (first leg 400 → proxy strips a field + retries
 * → second leg 200), where the client sees a single successful turn but `callCount()` reveals the
 * proxy hit upstream twice.
 */
export function sequencedUpstream(makers: Array<() => Response>): ScriptedUpstream {
  let calls = 0
  const bodies: Array<unknown> = []
  return {
    handler: (_url, init) => {
      bodies.push(parsedRequestBody(init))
      const maker = makers[Math.min(calls, makers.length - 1)]
      calls++
      return Promise.resolve(maker())
    },
    callCount: () => calls,
    requestBodies: () => bodies,
  }
}

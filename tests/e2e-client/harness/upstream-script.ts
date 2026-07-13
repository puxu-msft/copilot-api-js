export { createSseResponse, createSseResponseThenError } from "../../helpers/sse"

/** Build a non-streaming JSON upstream `Response` (status 200, `application/json`). Use for a
 *  non-streaming client call (`messages.create`) — the proxy forwards `stream:false` upstream and
 *  expects a JSON body (a streaming SSE body would make it JSON.parse `event: ...` → 500). */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

export interface ScriptedUpstream {
  /**
   * Feed to `setUpstreamFetchForTests`: every proxy→GHC call returns a fresh `makeResponse()`.
   * (A fresh Response per call — a `ReadableStream` body can only be consumed once, so retries /
   * multiple attempts each need their own.)
   */
  handler: (url: string | URL, init: unknown) => Promise<Response>
  /** How many times the proxy actually called upstream — the retry / no-retry oracle. */
  callCount: () => number
}

/** Build a scripted upstream that counts proxy→GHC calls and returns `makeResponse()` each time. */
export function scriptedUpstream(makeResponse: () => Response): ScriptedUpstream {
  let calls = 0
  return {
    handler: () => {
      calls++
      return Promise.resolve(makeResponse())
    },
    callCount: () => calls,
  }
}

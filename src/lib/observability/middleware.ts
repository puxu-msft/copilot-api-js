/**
 * Observability middleware — ensures every HTTP request reaches a terminal
 * state on the RequestContext, even when the handler throws without
 * calling complete/fail/abort itself.
 *
 * How termination flows in this app:
 *   - Hono's `server.onError` (src/server.ts:39) catches every uncaught
 *     handler throw BEFORE it propagates back through the middleware
 *     stack. The handler's `await next()` here therefore never throws —
 *     `onError` always returns a 4xx/5xx response, and we observe that
 *     status on `c.res.status` after `await next()` returns normally.
 *   - This middleware's job is the POST branch: read `c.res.status` and
 *     call `ctx.completeFromHttpStatus(status)`. Inside ctx,
 *     `completeFromHttpStatus` routes 2xx → complete(), 4xx+ → fail().
 *     The handler itself usually already called complete/fail before
 *     returning — those calls are idempotent (settled guard in
 *     request.ts), so this is a safety net for routes that never
 *     produced a ctx-aware response (rare; mostly /health-style).
 *
 * Lifecycle:
 *   - Synthetic routes (count-tokens) are exempted entirely — they don't
 *     create a RequestContext, don't appear in history/telemetry/TUI
 *     (per RFC §6 Q1).
 *   - SSE (text/event-stream): the stream consumer owns the terminal
 *     transition. Middleware does not finalize.
 *   - WebSocket upgrades: ctx terminal state is owned by ws.ts; the
 *     middleware doesn't finalize.
 *
 * Coexistence with the legacy `lib/tui/middleware.ts`: gone as of commit 4.
 * This middleware is the sole HTTP-layer observability touch point now.
 *
 * Why no try/catch wrapping `await next()`:
 *   Earlier drafts wrapped `next()` in try/catch and called
 *   `failIfNotFinalized(err)` on caught throws. That was dead code —
 *   `server.onError` consumes the throw upstream of us, so the catch
 *   never fires. The post-next status-driven path covers the failure
 *   case correctly because `onError` always sets status >= 400.
 *
 *   The catch DOES still matter at entry points that bypass Hono's
 *   routing/onError entirely — raw WebSocket upgrades (`responses/ws.ts`),
 *   stdio / non-HTTP entries, or a stack with a different error handler.
 *   That is why `ctx.failIfNotFinalized()` stays on the RequestContext API
 *   as a defensive primitive for those callers.
 */

import type {
  //
  Context,
  MiddlewareHandler,
  Next,
} from "hono"

import type { RequestContext } from "~/lib/context/request"

import { getIsShuttingDown } from "~/lib/shutdown"

/**
 * Routes that MUST NOT create a RequestContext or appear in observability.
 * Per RFC §6 Q1, count-tokens is a synthetic helper and pollutes
 * telemetry/history if treated as a real request. The middleware short-
 * circuits before any ctx-aware work happens.
 */
const SYNTHETIC_PATHS = new Set<string>(["/v1/messages/count_tokens", "/anthropic/v1/messages/count_tokens"])

export function observabilityMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Reject new requests during shutdown — keeps the legacy
    // tui/middleware.ts contract in place. Idempotent: if the legacy
    // middleware already returned 503, we won't reach here.
    if (getIsShuttingDown()) {
      return c.json({ type: "error", error: { type: "server_error", message: "Server is shutting down" } }, 503)
    }

    const path = c.req.path

    // Synthetic routes: no observability, no finalize, no nothing.
    // Handler runs unwrapped; the route's own `consola.info` lines are
    // the sole operator signal.
    if (SYNTHETIC_PATHS.has(path)) {
      await next()
      return
    }

    const isWebSocketUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket"

    await next()

    // WebSocket: ctx terminal state owned by ws.ts handler. Not our job.
    if (isWebSocketUpgrade) return

    // SSE: stream consumer owns finalization (after the stream ends).
    const contentType = c.res.headers.get("content-type")
    if (contentType?.includes("text/event-stream")) return

    // Non-streaming JSON path: if the handler created a ctx and didn't
    // finalize it, drive it from the HTTP status. Inside the ctx,
    // completeFromHttpStatus routes 2xx → complete(), 4xx+ → fail().
    // Already-settled ctx are no-op (settled guard in request.ts).
    const ctx = c.get("requestContext") as RequestContext | undefined
    if (ctx) {
      // P3: `c.res.status` is the status actually forwarded to the client — the authoritative
      // proxy→client boundary for defer-settle paths (handler threw a rejection → onError built
      // the error envelope → the ctx is still unsettled here). Capture it BEFORE
      // completeFromHttpStatus snapshots the entry, so `clientResponse.status` records the
      // forwarded status. Self-settled handlers already captured it at their own forward point;
      // this write lands post-snapshot for them (harmless no-op on the frozen entry).
      ctx.setClientResponseStatus(c.res.status)
      ctx.completeFromHttpStatus(c.res.status)
    }
  }
}

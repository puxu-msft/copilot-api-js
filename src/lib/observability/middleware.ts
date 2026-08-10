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

/**
 * Guarantees that every rejection we hand back while shutting down tells the client to drop the connection.
 *
 * This is load-bearing for the zero-downtime `--restart` handoff, not cosmetic.
 * Observed 2026-08-09: a takeover began at 13:02:06Z, and client sessions were still receiving the shutdown 503 at 13:09:24Z — over seven minutes later, long after the successor was listening and serving.
 * History shows nothing at all between 13:01:57.734Z and 13:11:46.755Z, because these rejections are answered before any RequestContext exists: the outage is invisible in our own records by construction.
 *
 * Two mechanisms can keep a client pinned to a dying process like that, and the incident evidence does not distinguish them:
 *   (A) the client's pooled keep-alive socket already points here, so its retry never asks the kernel for a new connection and never reaches the successor;
 *   (B) this process had not yet reached its listener close, so the kernel was still handing it fresh connections under SO_REUSEPORT.
 * This middleware closes (A); the listener-close ordering in `gracefulShutdown` (src/lib/shutdown.ts, Step 1) closes (B). Neither alone covers what the evidence permits, so do not drop one as redundant.
 *
 * Verified against undici, the HTTP stack Claude Code uses: 3 requests → 3 fresh connections when the response carries this header, vs. socket reuse when it does not.
 * Bun forwards the header but does not close the socket on its side, so for (A) the eviction is the client's doing.
 *
 * It lives here, as the OUTERMOST middleware, rather than on the shutdown 503 below, because that branch is not the only way we reject during shutdown.
 * The config/token middleware runs ahead of `observabilityMiddleware` and awaits `applyConfigToState()` / `ensureValidCopilotToken()`; either throwing lands in `server.onError` and never reaches the branch below.
 * A request already waiting on History admission is aborted by `stopHistoryAdmission()` and shaped by `onError` the same way.
 * Both were reproduced as 503s with no `Connection` header before this existed — hence one invariant at the shared base instead of a header on the one branch where the problem was first noticed.
 *
 * Scope note: only responses that failed. A 2xx completed during drain still leaves the socket pooled, so the client's next request costs one extra 503 before it reconnects. Widening this to every response would mean setting a header on already-streaming SSE responses, which is a separate question and deliberately not settled here.
 *
 * See docs/lifecycle.md「优雅重启」: the PoC hit this keep-alive behaviour 8/8 and correctly fixed its *probe* to use fresh connections, but the production consequence for pooled clients stayed open until now.
 */
export function shutdownConnectionCloseMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    await next()
    if (getIsShuttingDown() && c.res.status >= 400) c.header("Connection", "close")
  }
}

export function observabilityMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Reject new requests during shutdown — keeps the legacy tui/middleware.ts contract in place. Idempotent: if the legacy middleware already returned 503, we won't reach here.
    // `Connection: close` on this response is owned by `shutdownConnectionCloseMiddleware` above, which must be registered outermost; see its doc comment for why it is not set here.
    if (getIsShuttingDown()) {
      return c.json({ type: "error", error: { type: "server_error", message: "Server is shutting down" } }, 503, {
        "Retry-After": "1",
      })
    }

    const path = c.req.path

    // Synthetic routes: no RequestContext, no finalize, no `request.*` events,
    // no history/telemetry. The handler runs unwrapped and renders its own
    // outcome as a display-only request-shaped line (count_tokens →
    // `publishRequestLine` / `system.request_line`, reaching only TerminalUi +
    // FileSink — see synthetic-request-line.ts).
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
      ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
      ctx.setClientResponseStatus(c.res.status)
      ctx.completeFromHttpStatus(c.res.status)
      // Delivery finalization is independent from logical settle. A handler may already have
      // called abort()/fail()/complete() and intentionally rely on this non-streaming boundary
      // to seal the canonical operation (pre-response 499 is the critical case). Both methods
      // are idempotent, so explicitly-finalized handlers remain no-ops here.
      ctx.finalizeModelOperationDelivery()
    }
  }
}

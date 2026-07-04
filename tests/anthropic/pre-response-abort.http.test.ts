/**
 * Pre-response client-abort (② — docs/rfc/pre-response-abort-handling.md): when the
 * client disconnects WHILE the handler is still awaiting the upstream response
 * headers (before streamSSE opens), `runMessagesDriver`'s catch must settle the
 * RequestContext as the distinct `aborted` terminal (NOT `failed`) and return 499
 * (NOT rethrow into forwardError's 500 catch-all).
 *
 * Determinism: the upstream fetch mock aborts the inbound request signal (= the
 * client disconnect), then rejects with an http2-client-style AbortError — exactly
 * the pre-response shape (the upstream never sent response headers). No timers.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  //
  clearHistory,
  getHistory,
} from "~/lib/history"
import { observabilityMiddleware } from "~/lib/observability/middleware"
import {
  //
  setModelOverrides,
  setModels,
  setStateForTests,
} from "~/lib/state"
import { registerHttpRoutes } from "~/routes"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"

function makeAbortError(): Error {
  // Mirrors http2-client.ts abortError(): a generic AbortError (the TimeoutError
  // identity is intentionally NOT present — the discriminator is the signal, not name).
  const e = new Error("The operation was aborted.")
  e.name = "AbortError"
  return e
}

function observableApp(): Hono {
  // Production-faithful: onError → forwardError, plus observabilityMiddleware so a
  // settled ctx is not double-finalized from the HTTP status.
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.use(observabilityMiddleware())
  registerHttpRoutes(app)
  return app
}

describe("pre-response client abort → aborted + 499 (②)", () => {
  useIsolatedRuntime()

  let clientAbort: AbortController

  beforeEach(() => {
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    setModels({ object: "list", data: [mockModel("claude-opus-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
    setModelOverrides({ opus: "claude-opus-4.6" })
    clearHistory()

    clientAbort = new AbortController()
    // Simulate the client disconnecting while we await response headers: abort the
    // request signal (→ bridgeClientAbort flips the handler's clientAbort), then
    // reject with the http2-style AbortError. The upstream never returns headers.
    const mock = (_url: unknown, _init: unknown): Promise<Response> => {
      clientAbort.abort()
      return Promise.reject(makeAbortError())
    }
    applyFetchMock(mock as Parameters<typeof applyFetchMock>[0])
  })

  async function postStreaming(): Promise<Response> {
    return observableApp().request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.6", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
      signal: clientAbort.signal,
    })
  }

  test("streaming, client gone pre-response → 499 + history state 'aborted' (NOT 'failed')", async () => {
    const res = await postStreaming()
    // The delayed-commit window (default 20s) holds the stream un-opened; a pre-response client
    // disconnect settles within the window → settled path → 499 + `aborted` terminal (NOT failed),
    // not a committed 200. The `aborted` terminal proves ②'s ctx.abort() fired, not ctx.fail().
    expect(res.status).toBe(499)
    expect(getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state).toBe("aborted")
  })

  test("non-streaming, client gone pre-response → 499 + 'aborted' (shared outer catch)", async () => {
    const res = await observableApp().request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.6", stream: false, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
      signal: clientAbort.signal,
    })
    expect(res.status).toBe(499)
    expect(getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state).toBe("aborted")
  })
})

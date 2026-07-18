import { OpenAPIHono } from "@hono/zod-openapi"
import { Hono } from "hono"
import { type BlankEnv } from "hono/types"

import type { UiRoutesOptions } from "~/routes/ui/route"

import { forwardError } from "~/lib/error"
import { observabilityMiddleware } from "~/lib/observability/middleware"
import { registerHttpRoutes } from "~/routes"
import { registerOpenApiDocs } from "~/routes/openapi"
import { readinessCheck } from "~/server"

const browserProbePaths = new Set(["/favicon.ico", "/.well-known/appspecific/com.chrome.devtools.json"])

export function createFullTestApp(options: UiRoutesOptions = {}) {
  // Mirror src/server.ts — OpenAPIHono<BlankEnv> so the aggregated /openapi.json
  // + Scalar docs are exercised by the http test suite, not just the live server.
  const app = new OpenAPIHono<BlankEnv>()

  app.onError((error, c) => {
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return c.text("", 500)
    }
    return forwardError(c, error)
  })

  app.notFound((c) => {
    if (browserProbePaths.has(c.req.path)) {
      return c.body(null, 204)
    }
    return c.json({ error: "Not Found" }, 404)
  })

  app.get("/", (c) => c.redirect("/openapi.json"))

  app.get("/health/liveness", (c) => c.json({ status: "alive" }))

  app.get("/health", readinessCheck)
  app.get("/health/readiness", readinessCheck)

  // Mirrors src/server.ts:137 — the production observability safety-net that drives a ctx
  // to its terminal state from `c.res.status` when the handler didn't finalize it itself
  // (pre-response client-abort is the critical case, RFC pre-response-abort-handling). Without
  // this, a test-only app under-finalizes relative to production (History V2 removal Phase 1
  // audit: this gap was previously masked by the V2-only `attachHistorySink` in-flight mirror).
  app.use(observabilityMiddleware())

  registerHttpRoutes(app, options)
  registerOpenApiDocs(app)

  return app
}

export function createMinimalApp(setup: (app: Hono) => void) {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  setup(app)
  return app
}

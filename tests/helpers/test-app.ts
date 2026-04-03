import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { registerHttpRoutes } from "~/routes"
import type { UiRoutesOptions } from "~/routes/ui/route"

const browserProbePaths = new Set(["/favicon.ico", "/.well-known/appspecific/com.chrome.devtools.json"])

export function createFullTestApp(options: UiRoutesOptions = {}) {
  const app = new Hono()

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

  app.get("/", (c) => c.text("Server running"))

  app.get("/health", (c) => {
    const healthy = Boolean(state.copilotToken && state.githubToken)
    return c.json(
      {
        status: healthy ? "healthy" : "unhealthy",
        checks: {
          copilotToken: Boolean(state.copilotToken),
          githubToken: Boolean(state.githubToken),
          models: Boolean(state.models),
        },
      },
      healthy ? 200 : 503,
    )
  })

  registerHttpRoutes(app, options)

  return app
}

export function createMinimalApp(setup: (app: Hono) => void) {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  setup(app)
  return app
}

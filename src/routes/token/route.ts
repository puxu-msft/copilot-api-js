import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"

export const tokenRoutes = new Hono()

tokenRoutes.get("/", (c) => {
  try {
    return c.json({
      github: state.tokenInfo
        ? {
            token: state.tokenInfo.token,
            source: state.tokenInfo.source,
            expiresAt: state.tokenInfo.expiresAt ?? null,
            refreshable: state.tokenInfo.refreshable,
          }
        : null,
      copilot: state.copilotTokenInfo
        ? {
            token: state.copilotTokenInfo.token,
            expiresAt: state.copilotTokenInfo.expiresAt,
            refreshIn: state.copilotTokenInfo.refreshIn,
          }
        : null,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

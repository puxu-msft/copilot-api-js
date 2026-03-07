import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"

export const tokenRoutes = new Hono()

tokenRoutes.get("/", (c) => {
  try {
    return c.json({
      token: state.copilotToken,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

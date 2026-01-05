import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", async (c) => {
  try {
    return c.json({
      token: state.copilotToken,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

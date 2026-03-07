import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { getCopilotUsage } from "~/lib/token/copilot-client"

export const usageRoutes = new Hono()

usageRoutes.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    return forwardError(c, error)
  }
})

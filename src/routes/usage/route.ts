import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { getCopilotUsage } from "~/lib/token/copilot-client"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    return forwardError(c, error)
  }
})

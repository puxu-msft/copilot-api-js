import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    return await forwardError(c, error)
  }
})

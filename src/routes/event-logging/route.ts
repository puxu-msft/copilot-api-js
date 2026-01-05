import { Hono } from "hono"

export const eventLoggingRoutes = new Hono()

// Anthropic SDK sends telemetry to this endpoint
// Return 200 OK to prevent errors in the SDK
eventLoggingRoutes.post("/batch", (c) => {
  return c.text("OK", 200)
})

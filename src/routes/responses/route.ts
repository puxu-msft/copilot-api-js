/**
 * OpenAI Responses API route definition.
 * Handles POST /responses and POST /v1/responses.
 */

import { Hono } from "hono"

import { isV4DriverEnabled } from "~/lib/codec/driver-flags"
import { forwardError } from "~/lib/error"

import { handleResponses } from "./handler"
import { handleResponsesV4 } from "./handler-v4"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return isV4DriverEnabled("openai-responses") ? await handleResponsesV4(c) : await handleResponses(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})

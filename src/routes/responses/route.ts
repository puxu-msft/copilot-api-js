/**
 * OpenAI Responses API route definition.
 * Handles POST /responses and POST /v1/responses.
 */

import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponsesV4 } from "./handler-v4"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponsesV4(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})

/**
 * OpenAI Responses API route definition.
 * Handles POST /responses and POST /v1/responses.
 */

import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleChatCompletion } from "./handler"

export const chatCompletionRoutes = new Hono()

chatCompletionRoutes.post("/", async (c) => {
  try {
    return await handleChatCompletion(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

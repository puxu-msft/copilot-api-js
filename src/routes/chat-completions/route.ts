import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleChatCompletionV4 } from "./handler-v4"

export const chatCompletionRoutes = new Hono()

chatCompletionRoutes.post("/", async (c) => {
  try {
    return await handleChatCompletionV4(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})

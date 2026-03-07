import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCountTokens } from "./count-tokens-handler"
import { handleMessages } from "./handler"

export const messagesRoutes = new Hono()

messagesRoutes.post("/", async (c) => {
  try {
    return await handleMessages(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

messagesRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

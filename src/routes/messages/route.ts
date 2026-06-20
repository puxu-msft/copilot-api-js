import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCountTokens } from "./count-tokens"
import { handleMessagesV4 } from "./handler-v4"

export const messagesRoutes = new Hono()

messagesRoutes.post("/", async (c) => {
  try {
    return await handleMessagesV4(c)
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

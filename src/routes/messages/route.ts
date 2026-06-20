import { Hono } from "hono"

import { isV4DriverEnabled } from "~/lib/codec/driver-flags"
import { forwardError } from "~/lib/error"

import { handleCountTokens } from "./count-tokens"
import { handleMessages } from "./handler"
import { handleMessagesV4 } from "./handler-v4"

export const messagesRoutes = new Hono()

messagesRoutes.post("/", async (c) => {
  try {
    return isV4DriverEnabled("anthropic") ? await handleMessagesV4(c) : await handleMessages(c)
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

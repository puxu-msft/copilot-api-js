import { Hono } from "hono"

import { handleCountTokens } from "./count-tokens"
import { shapePrecommitError } from "./error-shaping-glue"
import { handleMessagesV4 } from "./handler-v4"

export const messagesRoutes = new Hono()

messagesRoutes.post("/", async (c) => {
  try {
    return await handleMessagesV4(c)
  } catch (error) {
    return shapePrecommitError(c, error)
  }
})

messagesRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return shapePrecommitError(c, error)
  }
})

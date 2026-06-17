import { Hono } from "hono"

import { isV4DriverEnabled } from "~/lib/codec/driver-flags"
import { forwardError } from "~/lib/error"

import { handleChatCompletion } from "./handler"
import { handleChatCompletionV4 } from "./handler-v4"

export const chatCompletionRoutes = new Hono()

chatCompletionRoutes.post("/", async (c) => {
  try {
    return isV4DriverEnabled("openai-cc") ? await handleChatCompletionV4(c) : await handleChatCompletion(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})

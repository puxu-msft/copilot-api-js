/**
 * Gemini-compatible HTTP routes.
 *
 * Path pattern: `/v1beta/models/:modelWithMethod` where `:modelWithMethod` is
 * `<model-id>:<method>` (e.g. `gpt-4o:generateContent`,
 * `gemini-2.5-pro:streamGenerateContent`). The method suffix dispatches to
 * one of three handlers below; unknown methods return 404 with a Gemini-shape
 * error body.
 */

import { Hono } from "hono"

import { isV4DriverEnabled } from "~/lib/codec/driver-flags"
import { forwardError } from "~/lib/error"

import {
  //
  handleCountTokens,
  handleGenerateContent,
  handleStreamGenerateContent,
} from "./handler"
import {
  //
  handleGenerateContentV4,
  handleStreamGenerateContentV4,
} from "./handler-v4"

export const geminiRoutes = new Hono()

geminiRoutes.post("/models/:modelWithMethod", async (c) => {
  try {
    const modelWithMethod = c.req.param("modelWithMethod")
    // Use lastIndexOf — the method suffix is always one of three known tokens
    // (generateContent / streamGenerateContent / countTokens) and never
    // contains a colon, so the LAST `:` delimits model id from method. Model
    // ids may legitimately contain `:` (e.g. vendor:family:variant), which
    // indexOf would have split incorrectly.
    const colon = modelWithMethod.lastIndexOf(":")
    if (colon === -1) {
      return c.json(
        {
          error: {
            code: 400,
            message: `Invalid path "${modelWithMethod}": expected <model>:<method>`,
            status: "INVALID_ARGUMENT",
          },
        },
        400,
      )
    }
    const modelId = modelWithMethod.slice(0, colon)
    const method = modelWithMethod.slice(colon + 1)

    if (method === "generateContent") {
      return isV4DriverEnabled("gemini") ? await handleGenerateContentV4(c, modelId) : await handleGenerateContent(c, modelId)
    }
    if (method === "streamGenerateContent") {
      return isV4DriverEnabled("gemini") ? await handleStreamGenerateContentV4(c, modelId) : await handleStreamGenerateContent(c, modelId)
    }
    if (method === "countTokens") {
      return await handleCountTokens(c, modelId)
    }

    return c.json(
      {
        error: {
          code: 404,
          message: `Method "${method}" is not implemented`,
          status: "NOT_FOUND",
        },
      },
      404,
    )
  } catch (error) {
    return forwardError(c, error, "gemini")
  }
})

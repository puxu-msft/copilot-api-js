import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
      // Include capabilities for clients that need token limit info
      capabilities:
        model.capabilities ?
          {
            family: model.capabilities.family,
            type: model.capabilities.type,
            tokenizer: model.capabilities.tokenizer,
            limits: {
              max_context_window_tokens:
                model.capabilities.limits?.max_context_window_tokens,
              max_output_tokens: model.capabilities.limits?.max_output_tokens,
              max_prompt_tokens: model.capabilities.limits?.max_prompt_tokens,
            },
            supports: {
              tool_calls: model.capabilities.supports?.tool_calls,
              parallel_tool_calls:
                model.capabilities.supports?.parallel_tool_calls,
            },
          }
        : undefined,
    }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

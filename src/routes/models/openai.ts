import { Hono } from "hono"

import type { Model } from "~/lib/models/client"

import { forwardError } from "~/lib/error"
import {
  //
  type OpenAIModelExtended,
  toOpenAIModelExtended,
} from "~/lib/models/capabilities-mapper"
import { state } from "~/lib/state"

import { ensureModels } from "./shared"

// ============================================================================
// OpenAI-compatible format (/models, /v1/models, /openai/v1/models)
// ============================================================================

/**
 * OpenAI standard model object — baseline 4 fields (`id`, `object`, `created`,
 * `owned_by`) augmented with Copilot capability information. The 4 baseline
 * fields remain at original positions/types; informational extras are ignored
 * by spec-compliant clients per the OpenAI spec.
 */
function toOpenAIModel(model: Model): OpenAIModelExtended {
  return toOpenAIModelExtended(model)
}

export const modelsRoutes = new Hono()

modelsRoutes.get("/", async (c) => {
  try {
    await ensureModels()

    return c.json({
      object: "list",
      data: state.models?.data.map((model) => toOpenAIModel(model)) ?? [],
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

modelsRoutes.get("/:model", async (c) => {
  try {
    await ensureModels()

    const modelId = c.req.param("model")
    const model = state.modelIndex.get(modelId)

    if (!model) {
      return c.json(
        {
          error: {
            message: `The model '${modelId}' does not exist`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
          },
        },
        404,
      )
    }

    return c.json(toOpenAIModel(model))
  } catch (error) {
    return forwardError(c, error)
  }
})

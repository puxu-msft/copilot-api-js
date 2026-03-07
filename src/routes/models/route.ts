import { Hono } from "hono"

import type { Model } from "~/lib/models/client"

import { forwardError } from "~/lib/error"
import { cacheModels } from "~/lib/models/client"
import { state } from "~/lib/state"

export const modelsRoutes = new Hono()

const EPOCH_ISO = new Date(0).toISOString()

function formatModel(model: Model) {
  return {
    id: model.id,
    object: "model" as const,
    type: "model" as const,
    created: 0, // No date available from source
    created_at: EPOCH_ISO, // No date available from source
    owned_by: model.vendor,
    display_name: model.name,
    capabilities: model.capabilities,
  }
}

modelsRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((m) => formatModel(m))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

modelsRoutes.get("/:model", async (c) => {
  try {
    if (!state.models) {
      await cacheModels()
    }

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

    return c.json(formatModel(model))
  } catch (error) {
    return forwardError(c, error)
  }
})

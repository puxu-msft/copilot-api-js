import { Hono } from "hono"

import type { Model } from "~/lib/models/client"

import { forwardError } from "~/lib/error"
import { cacheModels } from "~/lib/models/client"
import { state } from "~/lib/state"

export const modelsRoutes = new Hono()

/** Strip internal fields that should not be exposed to external consumers. */
function stripInternalFields(model: Model): Omit<Model, "request_headers"> {
  const { request_headers: _requestHeaders, ...rest } = model
  return rest
}

modelsRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // `?detail=true` remains accepted for backwards compatibility but is now a
    // no-op because the default response already returns the full public model.
    const models = state.models?.data.map(stripInternalFields)

    return c.json({
      object: state.models?.object ?? "list",
      data: models,
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

    return c.json(stripInternalFields(model))
  } catch (error) {
    return forwardError(c, error)
  }
})

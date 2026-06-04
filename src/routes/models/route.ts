import { Hono } from "hono"

import type { Model } from "~/lib/models/client"

import { forwardError } from "~/lib/error"
import { cacheModels } from "~/lib/models/client"
import { state } from "~/lib/state"

// ============================================================================
// Shared helpers
// ============================================================================

/** Ensure the models cache is populated, fetching if needed. */
async function ensureModels() {
  if (!state.models) {
    await cacheModels()
  }
}

/** Strip internal fields that should not be exposed to external consumers. */
function stripInternalFields(model: Model): Omit<Model, "request_headers"> {
  const { request_headers: _requestHeaders, ...rest } = model
  return rest
}

// ============================================================================
// OpenAI-compatible format (/models, /v1/models, /openai/v1/models)
// ============================================================================

/** OpenAI standard model object — only the fields defined by the OpenAI API spec. */
interface OpenAIModel {
  id: string
  object: "model"
  created: number
  owned_by: string
}

/** Convert a Copilot model to OpenAI standard format. */
function toOpenAIModel(model: Model): OpenAIModel {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: model.vendor,
  }
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

// ============================================================================
// Internal format (/api/models) — full Copilot model data
// ============================================================================

export const internalModelsRoutes = new Hono()

internalModelsRoutes.get("/", async (c) => {
  try {
    await ensureModels()

    return c.json({
      object: state.models?.object ?? "list",
      data: state.models?.data.map((model) => stripInternalFields(model)) ?? [],
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

internalModelsRoutes.get("/:model", async (c) => {
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

    return c.json(stripInternalFields(model))
  } catch (error) {
    return forwardError(c, error)
  }
})

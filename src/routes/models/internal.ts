import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import { state } from "~/lib/state"

import { ensureModels } from "./shared"

// ============================================================================
// Internal format (/api/models) — full Copilot model data
// ============================================================================

export const internalModelsRoutes = new OpenAPIHono()

/** Full Copilot model object (internal format). The upstream shape is large and
 *  evolves with the Copilot catalog, so it is described as an open object rather
 *  than enumerated here (would drift). Served verbatim — no fields stripped
 *  (ADR internal-tool-security-posture: this is an internal personal tool). */
const ModelSchema = z.record(z.string(), z.unknown()).openapi("CopilotModel")

const ModelListSchema = z
  .object({
    object: z.string(),
    data: z.array(ModelSchema),
  })
  .openapi("CopilotModelList")

/** OpenAI-style not-found envelope (matches the runtime 404 body). */
const ModelNotFoundSchema = z
  .object({
    error: z.object({
      message: z.string(),
      type: z.string(),
      param: z.string(),
      code: z.string(),
    }),
  })
  .openapi("ModelNotFound")

const listModelsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["models"],
  summary: "Internal model catalog (full Copilot data)",
  responses: {
    200: { description: "Model list", content: { "application/json": { schema: ModelListSchema } } },
  },
})

const getModelRoute = createRoute({
  method: "get",
  path: "/{model}",
  tags: ["models"],
  summary: "Single model (internal format)",
  request: { params: z.object({ model: z.string() }) },
  responses: {
    200: { description: "Model", content: { "application/json": { schema: ModelSchema } } },
    404: { description: "Model not found", content: { "application/json": { schema: ModelNotFoundSchema } } },
  },
})

internalModelsRoutes.openapi(listModelsRoute, async (c) => {
  await ensureModels()
  return c.json(
    {
      object: state.models?.object ?? "list",
      data: state.models?.data ?? [],
    },
    200,
  )
})

internalModelsRoutes.openapi(getModelRoute, async (c) => {
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

  return c.json(model, 200)
})

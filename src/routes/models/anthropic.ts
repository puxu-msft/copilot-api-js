import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  //
  buildAnthropicModelsList,
  toAnthropicModelInfo,
} from "~/lib/models/capabilities-mapper"
import { state } from "~/lib/state"

import { ensureModels } from "./shared"

/**
 * Anthropic-compatible models endpoint.
 *
 * Returns the `ModelInfo` shape declared by `@anthropic-ai/sdk/resources/models`
 * so Anthropic SDK clients pointed at `baseURL: ".../anthropic"` can decode
 * `client.models.list()` without modification.
 *
 * Filters to `vendor === "Anthropic"` to mirror Anthropic's own catalog —
 * GPT / Gemini models still routable via `/v1/messages` are intentionally
 * omitted here; use `/api/models` or `/v1/models` for the full catalog.
 *
 * `/anthropic/v1/models/:model` returns 404 when:
 *   - the id is not present in the cached catalog, OR
 *   - the cached model exists but its vendor is not `Anthropic` (since it
 *     would not appear in the list response, we keep the single-item endpoint
 *     consistent with the list).
 */
export const anthropicModelsRoutes = new Hono()

anthropicModelsRoutes.get("/", async (c) => {
  try {
    await ensureModels()
    const body = buildAnthropicModelsList(state.models?.data ?? [], { vendorFilter: "Anthropic" })
    return c.json(body)
  } catch (error) {
    return forwardError(c, error, "anthropic")
  }
})

anthropicModelsRoutes.get("/:model", async (c) => {
  try {
    await ensureModels()

    const modelId = c.req.param("model")
    const model = state.modelIndex.get(modelId)

    if (!model || model.vendor !== "Anthropic") {
      return c.json(
        {
          type: "error",
          error: {
            type: "not_found_error",
            message: `model: ${modelId}`,
          },
        },
        404,
      )
    }

    return c.json(toAnthropicModelInfo(model))
  } catch (error) {
    return forwardError(c, error, "anthropic")
  }
})

/**
 * Azure OpenAI classic deployment-based route compatibility.
 *
 * Maps Azure-style paths:
 *   POST /openai/deployments/:deployment/chat/completions?api-version=...
 *   POST /openai/deployments/:deployment/embeddings?api-version=...
 *   POST /openai/deployments/:deployment/responses?api-version=...
 *
 * The deployment name in the URL path always determines the model name,
 * matching Azure OpenAI behavior where the path segment is authoritative
 * and any body `model` field is ignored.
 */

import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { handleChatCompletion } from "~/routes/chat-completions/handler"
import { handleResponses } from "~/routes/responses/handler"
import { handleEmbeddings } from "~/routes/embeddings/route"

export const azureDeploymentRoutes = new Hono()

/**
 * Inject model from the :deployment path parameter into the request body.
 *
 * In Azure OpenAI, the deployment-id in the URL path is the authoritative
 * model identifier — the body `model` field is ignored. We always overwrite
 * it so that downstream handlers see the deployment name as the model.
 *
 * Sets `injectedPayload` on the Hono context so downstream handlers can
 * retrieve the pre-parsed body instead of calling `c.req.json()` again.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectDeploymentModel(c: any): Promise<Record<string, unknown>> {
  const deployment = c.req.param("deployment") as string
  const body = (await c.req.json()) as Record<string, unknown>
  // Always use deployment from URL path — Azure contract says path is authoritative
  body.model = deployment
  c.set("injectedPayload", body)
  return body
}

// ============================================================================
// Chat Completions
// ============================================================================

azureDeploymentRoutes.post("/:deployment/chat/completions", async (c) => {
  try {
    await injectDeploymentModel(c)
    return await handleChatCompletion(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

// ============================================================================
// Embeddings
// ============================================================================

azureDeploymentRoutes.post("/:deployment/embeddings", async (c) => {
  try {
    await injectDeploymentModel(c)
    return await handleEmbeddings(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

// ============================================================================
// Responses
// ============================================================================

azureDeploymentRoutes.post("/:deployment/responses", async (c) => {
  try {
    await injectDeploymentModel(c)
    return await handleResponses(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

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
import { handleChatCompletionV4 } from "~/routes/chat-completions/handler-v4"
import { handleEmbeddings } from "~/routes/embeddings/route"
import { handleResponsesV4 } from "~/routes/responses/handler-v4"

export const azureDeploymentRoutes = new Hono()

/**
 * Inject deployment-name as the model override for downstream handlers.
 *
 * In Azure OpenAI, the deployment-id in the URL path is the authoritative
 * model identifier — the body `model` field is ignored.
 *
 * We DO NOT mutate the parsed body. Instead, we expose two pieces of context:
 *
 *   - `injectedPayload`: the raw body as the client sent it (no model
 *     override applied). Downstream handlers consume this for both the
 *     pre-mutation snapshot AND the working payload, then apply the
 *     override via `azureModelOverride` once.
 *   - `azureModelOverride`: the deployment-name to use as the effective
 *     model. Handlers must read this and apply it AFTER snapshotting the
 *     original payload, so history reflects the snapshot with the
 *     override-resolved model (matching Azure protocol expectation).
 *
 * Rationale: mutating the body before any handler code runs means the
 * "original snapshot" captured later sees the post-mutation value. Keeping
 * the override as an explicit channel preserves caller-source-of-truth in
 * history while still respecting the Azure path-is-authoritative contract.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectDeploymentModel(c: any): Promise<void> {
  const deployment = c.req.param("deployment") as string
  const body = (await c.req.json()) as Record<string, unknown>
  c.set("injectedPayload", body)
  c.set("azureModelOverride", deployment)
}

// ============================================================================
// Chat Completions
// ============================================================================

azureDeploymentRoutes.post("/:deployment/chat/completions", async (c) => {
  try {
    await injectDeploymentModel(c)
    return await handleChatCompletionV4(c)
  } catch (error) {
    return forwardError(c, error, "openai")
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
    return forwardError(c, error, "openai")
  }
})

// ============================================================================
// Responses
// ============================================================================

azureDeploymentRoutes.post("/:deployment/responses", async (c) => {
  try {
    await injectDeploymentModel(c)
    return await handleResponsesV4(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})

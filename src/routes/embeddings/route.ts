import type { Context } from "hono"

import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  //
  createEmbeddings,
  type EmbeddingRequest,
} from "~/lib/openai/embeddings"

export const embeddingsRoutes = new Hono()

/** Handle an inbound embeddings request */
export async function handleEmbeddings(c: Context) {
  const payload = (c.get("injectedPayload") as EmbeddingRequest | undefined) ?? (await c.req.json<EmbeddingRequest>())
  // Azure deployment routes pass deployment-name via this channel; embeddings
  // doesn't snapshot for history (no /api/history for embeddings), so we apply
  // the override directly on the payload before calling upstream.
  const azureModelOverride = c.get("azureModelOverride") as string | undefined
  if (azureModelOverride !== undefined) {
    payload.model = azureModelOverride
  }
  const response = await createEmbeddings(payload)
  return c.json(response)
}

embeddingsRoutes.post("/", async (c) => {
  try {
    return await handleEmbeddings(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})

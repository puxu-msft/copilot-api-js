import type { Context } from "hono"

import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { createEmbeddings, type EmbeddingRequest } from "~/lib/openai/embeddings"

export const embeddingsRoutes = new Hono()

/** Handle an inbound embeddings request */
export async function handleEmbeddings(c: Context) {
  const payload =
    (c.get("injectedPayload") as EmbeddingRequest | undefined) ?? (await c.req.json<EmbeddingRequest>())
  const response = await createEmbeddings(payload)
  return c.json(response)
}

embeddingsRoutes.post("/", async (c) => {
  try {
    return await handleEmbeddings(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

import type {
  //
  Model,
  ModelsResponse,
} from "@hsupu/ghc-proxy-foundation/ghc-model-types"

import consola from "consola"

export type {
  //
  Model,
  ModelsResponse,
} from "@hsupu/ghc-proxy-foundation/ghc-model-types"

import {
  //
  copilotBaseUrl,
  copilotHeaders,
} from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { resolveResponseHeaderTimeoutMs } from "~/lib/models/timeout-resolver"
import { state } from "~/lib/state"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

/**
 * Cached ETag from the last successful /models response.
 * Sent as `If-None-Match` on subsequent requests; a 304 response means the
 * server confirmed our cache is current and we skip the JSON parse + setModels.
 * Module-scoped so it survives across refresh-loop ticks but resets on process restart.
 */
let modelsEtag: string | undefined

/** Test helper — reset the cached ETag to simulate a fresh process. */
export function resetModelsEtagForTests(): void {
  modelsEtag = undefined
}

/**
 * Fetch the /models catalog.
 *
 * Returns `undefined` when the server replies 304 Not Modified — in that case
 * the caller should keep its current cache unchanged. Returns the parsed body
 * on 200 OK.
 */
export const getModels = async (): Promise<ModelsResponse | undefined> => {
  const headers = copilotHeaders(state)
  if (modelsEtag) headers["If-None-Match"] = modelsEtag

  const response = await upstreamFetch(`${copilotBaseUrl(state)}/models`, {
    headers,
    // Model-catalog fetch has no per-model concept — intentionally scalar (no model arg).
    responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(undefined),
  })

  if (response.status === 304) {
    consola.debug("[Models] 304 Not Modified — keeping cached catalog")
    return undefined
  }

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get models", response)

  const etag = response.headers.get("etag")
  if (etag) modelsEtag = etag

  return (await response.json()) as ModelsResponse
}

/**
 * Internal `/api/models` envelope: the FULL (unfiltered) upstream catalog plus
 * `disabled` — the ids this project's `config.disabled_models` removed from the
 * usable set. Distinct from the upstream {@link ModelsResponse}: `disabled` is a
 * synthetic annotation (not an upstream field), kept at the envelope top level so
 * the per-model shape stays verbatim (richest-data-flow ADR).
 */
export interface InternalModelsResponse {
  object: string
  data: Array<Model>
  disabled: Array<string>
}

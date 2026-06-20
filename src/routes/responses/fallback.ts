/**
 * Fallback execution path for /v1/responses requests targeting models without
 * native /responses upstream support (Gemini, plain-chat Claude, etc.) or
 * vendors on the force-fallback list. Translates the Responses payload into a
 * Chat Completions request, calls the standard CC client, then translates the
 * response (or stream) back into Responses shape so the client is unaware.
 *
 * Companion to `handler.ts`'s `handleDirectResponses`. Both share the same
 * pre-dispatch setup in `handleResponses` (model resolution, instructions
 * processing, call-id normalization, history recording).
 */

import type { Context } from "hono"

import type { RequestContext } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  ResponsesPayload,
} from "~/types/api/openai-responses"

/**
 * Vendors whose Copilot /responses upstream is broken or absent; force
 * fallback even when the model claims to support /responses.
 *
 * Rationale: Copilot's /responses upstream returns 5xx for several Gemini
 * SKUs (observed by PR#3 author). Until Copilot stabilizes that path, route
 * Google models through /chat/completions. Update this list when upstream is
 * fixed.
 */
const FORCE_CC_VENDORS = new Set<string>(["Google"])

export function shouldForceChatCompletionsFallback(model: Model | undefined): boolean {
  return Boolean(model?.vendor && FORCE_CC_VENDORS.has(model.vendor))
}

/**
 * Restore function_call names (upstream → original) in a single Responses-shape
 * SSE data frame on the fallback path. Re-parses the frame (rather than mutating
 * the accumulated `event`) so history keeps upstream names. Best-effort: returns
 * input unchanged on parse failure / no change. No-op when `mapper` is null.
 */

/** Generate a short, collision-safe ID using crypto.randomUUID. */

export interface FallbackOptions {
  c: Context
  payload: ResponsesPayload
  reqCtx: RequestContext
  selectedModel: Model | undefined
}

/** Translate, execute via /chat/completions, translate back. */

/**
 * Shared codec model-resolution primitive.
 *
 * Every inbound codec (`anthropic` / `openai-cc` / `openai-responses` / `gemini`)
 * needs the same three model facts at `parse` time: the client's ORIGINAL
 * (pre-resolution) name, the resolved canonical upstream name, and the resolved
 * `Model` object. This module is the single source of truth for deriving them —
 * previously each codec re-derived the trio inline with subtly different (and in
 * one case buggy) logic.
 *
 * The load-bearing rule this centralizes: **the client-original name must come
 * from the client's raw body (`originalBodyForHistory ?? body`), NEVER from a
 * name a handler may have already resolved into `body.model`.** The v4 messages
 * handler rewrites `body.model` to the resolved name before parse (the other
 * formats pass the client-raw body), so reading the original off `body.model`
 * collapsed it to the resolved name and dropped the remap. Deriving it here, once,
 * makes every codec correct regardless of whether its handler pre-resolves.
 *
 * Suppression authority: {@link modelRemapParts} (i.e. {@link isSameModelName}) is
 * the ONE place that decides whether a client→resolved difference is a genuine
 * remap worth surfacing (`clientModel`) versus a mere spelling variant
 * (`claude-opus-4-8` vs `claude-opus-4.8`). Codecs no longer make that call with a
 * raw `!==`; they record `clientModel` only when this primitive yields one, so the
 * TUI (`modelRemapParts`) and the front-end (`resolved !== client`) stay consistent.
 * The raw original is still preserved verbatim as `requestedModel` (→ history
 * `requested` / `setOriginalRequest`), so nothing is pruned.
 */

import type { RouteOverride } from "~/lib/models/resolver"
import type { ResolvedModel } from "~/lib/pipeline/envelope"
import type { RawHttpRequest } from "~/lib/pipeline/types"

import {
  //
  modelRemapParts,
  resolveModelTarget,
} from "~/lib/models/resolver"
import { state } from "~/lib/state"

export interface CodecModelResolution {
  /**
   * The client's ORIGINAL (pre-resolution) model name — for the history
   * `requested` field and `setOriginalRequest`. Always the raw client name (URL
   * for gemini, `modelOverride` for Azure, else the client-raw body), never a
   * handler-resolved value.
   */
  requestedModel: string
  /** The resolved canonical upstream model name (post `model_mappings`). */
  resolvedName: string
  /** Client `@cc`/`@responses`/`@messages` leg pin carried through resolution. */
  routeOverride?: RouteOverride
  /** The resolved `Model` object — from `preResolved` or the live catalog. */
  selectedModel: ResolvedModel | undefined
  /**
   * The name to record as `ctx.clientModel` — present ONLY on a genuine remap
   * (spelling variants suppressed via {@link modelRemapParts}); `undefined`
   * otherwise. This is the single suppression authority for the display layers.
   */
  clientModel: string | undefined
}

/**
 * Derive the {@link CodecModelResolution} trio from a parsed inbound request.
 *
 * @param raw the inbound request; `originalBodyForHistory ?? body` is the
 *   client-raw body, `preResolved` (when the route pre-resolved) supplies the
 *   resolution, `modelOverride` is the Azure deployment override.
 * @param opts.requestedModel an explicit client-original name for formats whose
 *   model is not in the body (gemini reads it from the URL path).
 */
export function resolveCodecModel(raw: RawHttpRequest, opts?: { requestedModel?: string }): CodecModelResolution {
  const bodyModel = (raw.originalBodyForHistory ?? raw.body) as { model?: string } | undefined
  const requestedModel = raw.modelOverride ?? opts?.requestedModel ?? bodyModel?.model ?? ""
  const resolvedTarget = raw.preResolved ?? resolveModelTarget(requestedModel)
  const resolvedName = resolvedTarget.name
  const selectedModel = raw.preResolved ? raw.preResolved.model : state.modelIndex.get(resolvedName)
  return {
    requestedModel,
    resolvedName,
    ...(resolvedTarget.routeOverride && { routeOverride: resolvedTarget.routeOverride }),
    selectedModel,
    clientModel: modelRemapParts(requestedModel, resolvedName).source,
  }
}

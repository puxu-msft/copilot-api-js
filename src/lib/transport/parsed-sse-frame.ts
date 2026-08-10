import type { ServerSentEventMessage } from "fetch-event-stream"

import type { SseFrame } from "~/lib/stream"

import {
  //
  readSyntheticKind,
  tagFrameSynthetic,
} from "~/lib/pipeline/frame-origin"

/** Whether the current parsed event contained a valid `id` field on its own wire block. */
export type ParsedSseIdField = Readonly<{ kind: "absent" }> | Readonly<{ kind: "present"; value: string }>

/**
 * Producer-owned SSE parser output.
 *
 * `message.id` is the connection-local current last-event-ID string. `idField`
 * independently records whether this event carried a valid wire `id` field.
 */
export interface ParsedSseFrame {
  readonly kind: "parsed-sse"
  readonly message: ServerSentEventMessage & { readonly id: string }
  readonly idField: ParsedSseIdField
}

/** A parser output or a constructed wire-only frame flowing through the upstream pipeline. */
export type SemanticSseFrame = ParsedSseFrame | SseFrame

export function isParsedSseFrame(frame: SemanticSseFrame): frame is ParsedSseFrame {
  return "kind" in frame
}

/** Read the semantic event fields without confusing current ID state with wire field presence. */
export function semanticSseMessage(frame: SemanticSseFrame): SseFrame {
  return isParsedSseFrame(frame) ? frame.message : frame
}

export type SemanticSseRewriteKind = "preserve" | "fresh"

/**
 * Apply an explicitly classified semantic rewrite.
 *
 * `preserve` may only re-emit the exact parser message and keeps its event-local
 * provenance. `fresh` is a constructed wire frame that owns every field itself.
 */
export function mapSemanticSseFrame(frame: SemanticSseFrame, map: (message: SseFrame) => SseFrame, kind: SemanticSseRewriteKind): SemanticSseFrame {
  const message = map(semanticSseMessage(frame))
  if (kind === "fresh") return message
  if (!isParsedSseFrame(frame)) return message
  if (message !== frame.message) throw new Error("[parsed-sse] preserve rewrite must re-emit the exact semantic input")
  return frame
}

/**
 * Explicit direct-render projection from parser semantics to client wire fields.
 * Translation outputs fresh wire frames instead and therefore terminate provenance.
 */
export function projectParsedSseFrame(frame: SemanticSseFrame): SseFrame {
  if (!isParsedSseFrame(frame)) return frame
  const { event, data, retry } = frame.message
  const projected = {
    ...(event !== undefined && { event }),
    ...(data !== undefined && { data }),
    ...(frame.idField.kind === "present" && { id: frame.idField.value }),
    ...(retry !== undefined && { retry }),
  }
  const origin = readSyntheticKind(frame)
  return origin === undefined ? projected : tagFrameSynthetic(projected, origin)
}

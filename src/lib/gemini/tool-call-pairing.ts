/**
 * Resolve `functionCall` / `functionResponse` pairing in a Gemini `contents`
 * array.
 *
 * Why this exists: Gemini's API allows clients to send
 * `functionCall`/`functionResponse` parts WITHOUT an explicit `id`, relying on
 * positional pairing within `contents` (langchain-google-genai 4.x does this).
 * OpenAI's Chat Completions API on the other hand REQUIRES a `tool_call_id`
 * on every `tool` message and matches it against the preceding assistant
 * tool_call. Without pairing here, every tool-using Gemini conversation
 * through this proxy fails upstream.
 *
 * Strategy: walk all parts in document order, assigning a stable callId to
 * every `functionCall` (using its `id` when present, else a synthetic id),
 * and push that callId onto a per-name FIFO queue. When we then encounter a
 * `functionResponse` without an `id`, we drain the queue for that name to
 * recover the matching callId.
 *
 * Ported from agent-maestro/src/server/utils/gemini.ts
 * (convertGeminiContentsToVSCode, the pre-walk + FIFO drain pass) — adapted
 * to return a `Map<Part, string>` instead of inlining the conversion, so the
 * pairing logic can be reused by request conversion and is easier to test.
 */

import type {
  //
  Content,
  Part,
} from "~/types/api/gemini"

/**
 * Prefix for synthetic call ids assigned when a Gemini `functionCall` arrives
 * without an explicit `id`. Chosen to be structurally impossible for a real
 * client to emit by accident: it leads with `__synth__:` (double underscore,
 * colon) — none of the Gemini SDK / langchain-google-genai id-generation paths
 * produce that shape, so an explicit id sharing this prefix can only come from
 * a deliberate attempt to collide.
 */
export const SYNTHETIC_CALL_ID_PREFIX = "__synth__:fn:"

/** Resolved callIds keyed by the Part reference */
export type CallIdMap = WeakMap<object, string>

/** Output of pairing: per-part resolved callIds for both call and response */
export interface PairingResult {
  /** Resolved callId for each `functionCall` part */
  callIds: CallIdMap
  /** Resolved callId for each `functionResponse` part */
  responseIds: CallIdMap
}

/**
 * Walk every `functionCall` / `functionResponse` part in `contents` and
 * compute the matching callId for each.
 *
 * Two-pass strategy:
 *
 * 1. Pre-walk: assign a stable callId to every `functionCall` and push it onto
 *    a per-name FIFO queue.
 *
 * 2. Reservation pass: walk every `functionResponse` THAT HAS AN EXPLICIT ID
 *    first and remove the matching callId from its queue. This guarantees the
 *    explicit id wins regardless of document order.
 *
 * 3. FIFO drain pass: walk every `functionResponse` WITHOUT an id and pop the
 *    next remaining callId from the queue.
 *
 * Without the reservation pass, an id-less response that appears BEFORE an
 * explicit-id response in document order would drain the queue head — leaving
 * two responses both resolving to the same callId (the very bug previously
 * documented as "acceptable" in tests, which it is not).
 */
export function pairFunctionCalls(contents: ReadonlyArray<Content>): PairingResult {
  const callIds: CallIdMap = new WeakMap()
  const responseIds: CallIdMap = new WeakMap()
  const pendingByName = new Map<string, Array<string>>()
  let synthCounter = 0

  // Pass 1: assign a callId to every functionCall.
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.functionCall?.name) {
        const callId = part.functionCall.id || `${SYNTHETIC_CALL_ID_PREFIX}${synthCounter++}:${part.functionCall.name}`
        callIds.set(part as unknown as object, callId)
        const queue = pendingByName.get(part.functionCall.name) ?? []
        queue.push(callId)
        pendingByName.set(part.functionCall.name, queue)
      }
    }
  }

  // Pass 2: reserve callIds for explicit-id responses FIRST so they cannot be
  // stolen by an earlier id-less response sharing the same name.
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (!part.functionResponse?.name) continue
      if (!part.functionResponse.id) continue
      const queue = pendingByName.get(part.functionResponse.name)
      if (!queue) continue
      const matchedIndex = queue.indexOf(part.functionResponse.id)
      if (matchedIndex !== -1) queue.splice(matchedIndex, 1)
      responseIds.set(part as unknown as object, part.functionResponse.id)
    }
  }

  // Pass 3: drain the remaining queue for id-less responses (FIFO).
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (!part.functionResponse?.name) continue
      if (part.functionResponse.id) continue
      const queue = pendingByName.get(part.functionResponse.name)
      if (!queue || queue.length === 0) continue
      const resolved = queue.shift()
      if (resolved) responseIds.set(part as unknown as object, resolved)
    }
  }

  return { callIds, responseIds }
}

/** Look up the resolved callId for a `functionCall` part. */
export function resolveCallId(part: Part, pairing: PairingResult): string | undefined {
  return pairing.callIds.get(part as unknown as object)
}

/** Look up the resolved tool_call_id for a `functionResponse` part. */
export function resolveResponseId(part: Part, pairing: PairingResult): string | undefined {
  return pairing.responseIds.get(part as unknown as object)
}

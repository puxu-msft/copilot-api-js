/**
 * Stream ID synchronization for Responses API.
 *
 * GitHub Copilot's Responses API returns different IDs for the same output item
 * in `response.output_item.added` vs `response.output_item.done` events.
 * This breaks clients like @ai-sdk/openai that expect consistent IDs
 * across the stream lifecycle (errors: "activeReasoningPart.summaryParts" undefined,
 * "text part not found").
 *
 * This module tracks the canonical ID from `added` events and patches subsequent
 * events to use the same ID, ensuring consistency for downstream consumers.
 *
 * **Best-effort guarantee:** every public helper here returns the original
 * `data` string unchanged on any parse failure. ID correction is an
 * optimization for downstream clients — a single malformed frame must never
 * abort the stream consumer that called us. Callers may sit outside the
 * SSE-parse try/catch and rely on this contract.
 */

import consola from "consola"

export interface StreamIdTracker {
  /** output_index → canonical item ID from the "added" event */
  readonly outputItems: Map<number, string>
}

export function createStreamIdTracker(): StreamIdTracker {
  return { outputItems: new Map() }
}

/**
 * Fix inconsistent item IDs in a Responses API stream event.
 *
 * Returns the corrected JSON string. If no correction is needed,
 * returns the original string unchanged (same reference).
 */
export function fixStreamEventIds(data: string, eventType: string | undefined, tracker: StreamIdTracker): string {
  if (!data) return data

  switch (eventType) {
    case "response.output_item.added": {
      return handleOutputItemAdded(data, tracker)
    }
    case "response.output_item.done": {
      return handleOutputItemDone(data, tracker)
    }
    default: {
      return handleItemId(data, eventType, tracker)
    }
  }
}

// ============================================================================
// Event handlers
// ============================================================================

interface AddedEventShape {
  output_index: number
  item: { id?: string }
}

function handleOutputItemAdded(data: string, tracker: StreamIdTracker): string {
  const parsed = tryParse(data, "response.output_item.added") as AddedEventShape | undefined
  if (!parsed) return data

  // Generate a stable ID if missing
  if (!parsed.item.id) {
    let suffix = ""
    while (suffix.length < 16) {
      suffix += Math.random().toString(36).slice(2)
    }
    parsed.item.id = `oi_${parsed.output_index}_${suffix.slice(0, 16)}`
    tracker.outputItems.set(parsed.output_index, parsed.item.id)
    return JSON.stringify(parsed)
  }

  tracker.outputItems.set(parsed.output_index, parsed.item.id)
  return data
}

interface DoneEventShape {
  output_index: number
  item: { id?: string }
}

function handleOutputItemDone(data: string, tracker: StreamIdTracker): string {
  const parsed = tryParse(data, "response.output_item.done") as DoneEventShape | undefined
  if (!parsed) return data
  const canonicalId = tracker.outputItems.get(parsed.output_index)

  if (canonicalId && parsed.item.id !== canonicalId) {
    parsed.item.id = canonicalId
    return JSON.stringify(parsed)
  }

  return data
}

/** Events with output_index + item_id (delta/done events for function calls, etc.) */
interface IndexedEventShape {
  output_index?: number
  item_id?: string
}

/** Event types that carry an item_id field referencing an output item */
const ITEM_ID_EVENT_TYPES = new Set(["response.function_call_arguments.delta", "response.function_call_arguments.done"])

function handleItemId(data: string, eventType: string | undefined, tracker: StreamIdTracker): string {
  if (!eventType || !ITEM_ID_EVENT_TYPES.has(eventType)) return data

  const parsed = tryParse(data, eventType) as IndexedEventShape | undefined
  if (!parsed) return data
  if (parsed.output_index === undefined) return data

  const canonicalId = tracker.outputItems.get(parsed.output_index)
  if (canonicalId && parsed.item_id !== canonicalId) {
    parsed.item_id = canonicalId
    return JSON.stringify(parsed)
  }

  return data
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Best-effort JSON.parse — returns `undefined` on failure so callers can fall
 * back to passing the original `data` through unchanged. Logs at debug to keep
 * malformed-frame incidents visible without spamming production logs.
 */
function tryParse(data: string, eventType: string): unknown {
  try {
    return JSON.parse(data)
  } catch (err) {
    consola.debug(
      `[stream-id-sync] skipping ID correction for unparseable ${eventType} frame (${err instanceof Error ? err.message : String(err)}):`,
      data.slice(0, 200),
    )
    return undefined
  }
}

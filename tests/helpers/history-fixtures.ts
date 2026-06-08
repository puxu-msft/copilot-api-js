/**
 * Shared history-store test fixtures.
 *
 * Builders for `HistoryEntry` objects used by history-store / history-summary
 * tests. These were previously copy-pasted byte-for-byte across those files.
 */

import type {
  //
  EndpointType,
  HistoryEntry,
} from "~/lib/history"

import {
  //
  getCurrentSession,
  insertEntry,
} from "~/lib/history"
import { generateId } from "~/lib/utils"

/**
 * Build a `HistoryEntry` from a minimal request, **insert it into the history
 * store**, and return it. `stream` defaults to `true`; optional request fields
 * (`tools`, `max_tokens`, `temperature`, `system`) are passed through when set.
 *
 * Side-effectful by design — it seeds the global history store so queries /
 * summaries under test have data to read.
 */
export function insertHistoryEntry(
  endpoint: EndpointType,
  request: Partial<HistoryEntry["request"]> & { model: string; messages: HistoryEntry["request"]["messages"] },
): HistoryEntry {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
    endpoint,
    request: {
      model: request.model,
      messages: request.messages,
      stream: request.stream ?? true,
      tools: request.tools,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      system: request.system,
    },
  }
  insertEntry(entry)
  return entry
}

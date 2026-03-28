/**
 * WebSocket support for History API — thin re-export wrapper.
 *
 * All WebSocket logic has moved to `~/lib/ws/index.ts` (topic-aware broadcast system).
 * This file preserves backward compatibility for existing importers:
 * - `src/lib/history/store.ts` (imports notify functions)
 * - `src/lib/history/index.ts` (re-exports to consumers)
 * - `tests/unit/history-ws.test.ts` (unit tests)
 * - `ui/history-v3/src/types/ws.ts` (frontend type re-export)
 *
 * NOTE: Uses relative import (`../ws`) instead of alias (`~/lib/ws`) because this
 * file is consumed by the frontend `vue-tsc` which doesn't have the `~/*` path alias.
 */

import { getStats } from "./stats"

export type { WSMessage, WSMessageType } from "../ws"

export {
  addClient,
  closeAllClients,
  getClientCount,
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyHistoryCleared,
  notifySessionDeleted,
  notifyStatsUpdated,
  removeClient,
} from "../ws"

import { notifyStatsUpdated as broadcastStatsUpdated } from "../ws"

export function notifyStatsChanged(): void {
  broadcastStatsUpdated(getStats())
}

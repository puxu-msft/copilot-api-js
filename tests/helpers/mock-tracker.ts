/**
 * Mock request tracker for shutdown tests.
 */

import { mock } from "bun:test"
import type { TuiLogEntry } from "~/lib/tui/types"

export function createMockTracker(initialRequests: Array<Partial<TuiLogEntry>> = []) {
  let requests = initialRequests.map(
    (r) =>
      ({
        id: r.id ?? `req-${Math.random().toString(36).slice(2, 8)}`,
        method: r.method ?? "POST",
        path: r.path ?? "/v1/messages",
        status: r.status ?? "executing",
        startTime: r.startTime ?? Date.now(),
        model: r.model ?? "claude-sonnet-4",
        tags: r.tags ?? [],
        ...r,
      }) as TuiLogEntry,
  )

  return {
    getActiveRequests: mock(() => [...requests]),
    destroy: mock(() => {
      requests = []
    }),
    _setActiveRequests: (r: Array<Partial<TuiLogEntry>>) => {
      requests = r.map(
        (req) =>
          ({
            id: req.id ?? `req-${Math.random().toString(36).slice(2, 8)}`,
            method: req.method ?? "POST",
            path: req.path ?? "/v1/messages",
            status: req.status ?? "executing",
            startTime: req.startTime ?? Date.now(),
            model: req.model ?? "claude-sonnet-4",
            tags: req.tags ?? [],
            ...req,
          }) as TuiLogEntry,
      )
    },
    _clearRequests: () => {
      requests = []
    },
  }
}

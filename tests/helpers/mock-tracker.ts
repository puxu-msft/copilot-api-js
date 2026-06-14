/**
 * Mock drain source for shutdown tests. Replaces the legacy TuiLogEntry-
 * shaped mock with a RequestContext-shaped one matching `ShutdownDrainSource`.
 */

import { mock } from "bun:test"

import type { RequestContext } from "~/lib/context/request"

/** Minimal RequestContext stub for shutdown drain tests. */
type FakeRequest = Partial<Pick<RequestContext, "id" | "method" | "path" | "state" | "startTime" | "resolvedModel">> & {
  /** Legacy field — accepted for back-compat with older test fixtures; mapped to `resolvedModel`. */
  model?: string
  /** Legacy field — accepted for back-compat; mapped to `state`. */
  status?: string
  /** Legacy field — accepted for back-compat; ignored (tags are gone post-RFC). */
  tags?: Array<string>
}

function buildContextStub(r: FakeRequest): RequestContext {
  const id = r.id ?? `req-${Math.random().toString(36).slice(2, 8)}`
  // Tests only read id/method/path/state/startTime/resolvedModel; the
  // rest of the RequestContext surface isn't exercised by shutdown drain
  // code, so we stub with no-op/null values and assert the shape via
  // `as unknown as RequestContext` (no behavioural surface to honor).
  return {
    id,
    method: r.method ?? "POST",
    path: r.path ?? "/v1/messages",
    state: (r.state ?? r.status ?? "executing") as RequestContext["state"],
    startTime: r.startTime ?? Date.now(),
    resolvedModel: r.resolvedModel ?? r.model ?? "claude-sonnet-4",
  } as unknown as RequestContext
}

export function createMockTracker(initialRequests: Array<FakeRequest> = []) {
  let requests = initialRequests.map(buildContextStub)

  return {
    /** ShutdownDrainSource interface — production passes manager.getAll(). */
    getActive: mock(() => [...requests]),
    /** Test-only: replace the active set. */
    _setActiveRequests: (r: Array<FakeRequest>) => {
      requests = r.map(buildContextStub)
    },
    _clearRequests: () => {
      requests = []
    },
  }
}

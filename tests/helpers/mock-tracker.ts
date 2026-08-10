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

  // Shared spies for the request-level termination primitives that the stale reaper, `timeouts.request_deadline`, and shutdown's drain abandonment all drive.
  // The stub above deliberately omits most of RequestContext, but these two MUST be mirrored: production's `abandonDrain` calls them, and a stub without them sends that call into a catch block — the test would then go green having exercised nothing (`fake-must-mirror-real-protocol`).
  const reapInFlight = mock((_id: string) => {})
  const fail = mock((_id: string, _model: string, _error: unknown, _opts?: unknown) => {})

  const build = (r: FakeRequest): RequestContext => {
    const stub = buildContextStub(r)
    return Object.assign(stub, {
      reapInFlight: () => reapInFlight(stub.id),
      fail: (model: string, error: unknown, _partial?: unknown, opts?: unknown) => {
        fail(stub.id, model, error, opts)
        // A terminated operation eventually leaves the registry in production, so model that here — otherwise the drain loop would spin forever on an operation the test just killed.
        requests = requests.filter((candidate) => candidate.id !== stub.id)
      },
    }) as unknown as RequestContext
  }

  requests = initialRequests.map(build)

  return {
    /** ShutdownDrainSource interface — production passes manager.getAll(). */
    getActive: mock(() => [...requests]),
    /** Test-only: replace the active set. */
    _setActiveRequests: (r: Array<FakeRequest>) => {
      requests = r.map(build)
    },
    _clearRequests: () => {
      requests = []
    },
    /** Test-only spies: did the drain-abandonment path actually reach these operations? */
    _reapInFlight: reapInFlight,
    _fail: fail,
  }
}

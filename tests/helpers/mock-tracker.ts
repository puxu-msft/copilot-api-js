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
  /**
   * Start this stub already settled — i.e. the request itself reached a terminal state but its FINALIZATION (History terminal, delivery, canonical publish) has not completed, so it is STILL in the registry.
   *
   * This is not an exotic case: it is what the drain is usually left holding at the end, because `releaseTrackedOperationIfTerminal` is a deliberate no-op while `blocker !== "none"` (`src/lib/context/manager.ts`) — the ctx stays visible rather than silently vanishing.
   */
  settled?: boolean
  /**
   * Whether this stub leaves the registry once it settles — i.e. whether release would find `blocker === "none"`.
   *
   * Defaults to true (the mainstream shape: nothing else is holding it, so terminating it lets the drain finish). Set false to model an operation wedged in finalization, which stays tracked no matter what tier 2 does to it.
   */
  releasesOnSettle?: boolean
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
    // Mirror production's settledness, because BOTH primitives branch on it: `fail()` early-returns via `if (settled) return` (`src/lib/context/request.ts`), and shutdown's tier 2 reads `ctx.settled` to decide whether it may touch the operation at all.
    let settled = r.settled ?? false
    // Mirror production's release rule. A fake that removes the request the moment `fail()` is called would GUARANTEE the "tier 2 → registry empties → finalize" causal chain in every test, including the shapes where production does not deliver it — the chain would be a property of the stub, not of the code under test.
    const releasesOnSettle = r.releasesOnSettle ?? true

    const withPrimitives = Object.assign(stub, {
      reapInFlight: () => reapInFlight(stub.id),
      fail: (model: string, error: unknown, _partial?: unknown, opts?: unknown) => {
        if (settled) return // `request.ts`: fail() on an already-settled ctx is a no-op, spies included.
        fail(stub.id, model, error, opts)
        settled = true
        if (releasesOnSettle) requests = requests.filter((candidate) => candidate.id !== stub.id)
      },
    })
    // `Object.assign` copies a getter's VALUE, not the getter — spreading `{ get settled() {...} }` above would freeze it at its initial value and silently defeat the whole point of mirroring settledness.
    Object.defineProperty(withPrimitives, "settled", { get: () => settled, configurable: true })
    return withPrimitives as unknown as RequestContext
  }

  requests = initialRequests.map(build)

  /**
   * A lightweight in-flight operation (count_tokens / embeddings), which the real drain source unions in alongside generation contexts.
   *
   * It carries the primitive spies too — **deliberately**. Production tells the two apart by `"operationId" in operation` and skips lightweight ones because they have no cancellation surface at all; giving the stub a working `reapInFlight`/`fail` means that if that discriminator is ever removed, the call lands on these spies and a test can SEE it. A stub without them would just throw into tier 2's catch block and stay green.
   */
  const buildLightweight = (operationId: string): RequestContext =>
    ({
      operationId,
      reapInFlight: () => reapInFlight(operationId),
      fail: (model: string, error: unknown, _partial?: unknown, opts?: unknown) => {
        fail(operationId, model, error, opts)
      },
    }) as unknown as RequestContext

  return {
    /** ShutdownDrainSource interface — production passes manager.getAll(). */
    getActive: mock(() => [...requests]),
    /** Test-only: replace the active set. */
    _setActiveRequests: (r: Array<FakeRequest>) => {
      requests = r.map(build)
    },
    /** Test-only: seed the active set with a mix of generation contexts and lightweight operations, as the real union produces. */
    _setActiveMixed: (r: Array<FakeRequest>, lightweightIds: Array<string>) => {
      requests = [...r.map(build), ...lightweightIds.map((id) => buildLightweight(id))]
    },
    _clearRequests: () => {
      requests = []
    },
    /** Test-only spies: did the drain-abandonment path actually reach these operations? */
    _reapInFlight: reapInFlight,
    _fail: fail,
  }
}

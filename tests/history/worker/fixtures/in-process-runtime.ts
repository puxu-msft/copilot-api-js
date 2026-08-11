import type { HistoryWorkerBackend, HistoryWorkerBackendDeps } from "~/lib/history/worker/backend"
import type { HistoryWorkerTransport } from "~/lib/history/worker/runtime"

import {
  //
  createHistoryWorkerBackend,
  installHistoryWorkerMessageLoop,
} from "~/lib/history/worker/backend"
import { HistoryPersistenceRuntimeImpl } from "~/lib/history/worker/runtime"

/**
 * In-process counterpart of the real Worker, for the shared protocol contract suite.
 *
 * It runs the SAME message loop over the SAME backend — only the thread boundary is
 * removed — so it cannot be friendlier than the real Worker (spec §12.1). That is also
 * what makes it usable as Batch 2b's negative control: with persistence on this thread,
 * a blocking backend MUST freeze liveness, which is the observation that proves the real
 * Worker's isolation is doing something.
 *
 * It lives in tests rather than in `runtime.ts` because composing it requires importing
 * the backend, and the main thread's module graph must stay free of `bun:sqlite` and the
 * compression codec — the dependency this whole migration exists to remove.
 */
export function createInProcessHistoryPersistenceRuntime(
  deps: HistoryWorkerBackendDeps = {},
  /** Wrap the backend before the message loop drives it — the seam the isolation control uses to inject the SAME synchronous block the real-Worker arm injects. */
  wrapBackend: (backend: HistoryWorkerBackend) => HistoryWorkerBackend = (backend) => backend,
): HistoryPersistenceRuntimeImpl {
  return new HistoryPersistenceRuntimeImpl({
    workerFactory: () => {
      const transport = new InProcessHistoryWorkerTransport()
      // A retryable startup failure must look like a dead generation, not like a dead
      // process: the real Worker's `process.exit` would end the HOST here (the proxy, or
      // the test runner), so this host reports the same thing through an `exit` event.
      installHistoryWorkerMessageLoop(transport.workerPort, wrapBackend(createHistoryWorkerBackend(deps)), {
        terminateForRestart: (exitCode) => transport.simulateExit(exitCode),
      })
      return transport
    },
  })
}

/**
 * A message-port pair with no thread between them. Both directions go through
 * `structuredClone`, so a value the real Worker could not transfer fails here too.
 */
class InProcessHistoryWorkerTransport implements HistoryWorkerTransport {
  private readonly mainListeners = new Set<(value: unknown) => void>()
  private readonly workerListeners = new Set<(value: unknown) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()
  private closed = false

  readonly workerPort = {
    postMessage: (value: unknown) => {
      if (this.closed) return
      const cloned = structuredClone(value)
      queueMicrotask(() => {
        for (const listener of this.mainListeners) listener(cloned)
      })
    },
    on: (_event: "message", listener: (value: unknown) => void) => {
      this.workerListeners.add(listener)
      return this.workerPort
    },
    close: () => {
      this.closed = true
    },
  }

  send(value: unknown): void {
    if (this.closed) return
    const cloned = structuredClone(value)
    queueMicrotask(() => {
      for (const listener of this.workerListeners) listener(cloned)
    })
  }

  /** This host's equivalent of a Worker thread exiting: the generation dies, the process does not. */
  simulateExit(code: number): void {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => {
      for (const listener of this.exitListeners) listener(code)
    })
  }

  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  on(event: "message" | "error" | "exit", listener: (value: never) => void): this {
    if (event === "message") this.mainListeners.add(listener as (value: unknown) => void)
    if (event === "exit") this.exitListeners.add(listener as (code: number) => void)
    return this
  }

  terminate(): Promise<number> {
    this.closed = true
    return Promise.resolve(0)
  }
}

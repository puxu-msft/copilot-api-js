/**
 * Main-thread client for the tokenizer Worker.
 *
 * Owns one lazily-spawned Worker and the request/response bookkeeping around it. The contract it offers callers is narrow on purpose: hand over a job and a way to do that same job here, and get the answer — the caller never learns which thread produced it, and never has to handle "the Worker is missing" as a case of its own.
 *
 * The fallback is not a nicety. Token counting decides truncation boundaries and calibration, so a Worker that fails to spawn on some platform must degrade to a slow main thread, never to a wrong number or a thrown request.
 */

/* eslint-disable unicorn/require-post-message-target-origin -- `targetOrigin` is a `window.postMessage` parameter; a `Worker` has no such argument and passing one would be a type error. The rule's own metadata marks it `recommended: false` for exactly this reason: it cannot tell `window.postMessage` from `{Worker,MessagePort}#postMessage` (unicorn#1396). */

import consola from "consola"
import {
  //
  Worker,
} from "node:worker_threads"

import type {
  //
  TokenizerJob,
  TokenizerResponse,
} from "./tokenizer-protocol"

import {
  //
  resolveTokenizerWorkerUrl,
} from "./tokenizer-worker-url"

/**
 * How many times to try spawning before giving up for the life of the process.
 *
 * A Worker that cannot be created is almost always a permanent condition — a missing build artifact, a platform without worker threads — so retrying forever would just move the cost from "one failed spawn" to "one failed spawn per request". A crash mid-flight is the case worth retrying, and three attempts distinguishes the two without ceremony.
 */
const MAX_SPAWN_ATTEMPTS = 3

interface PendingRequest {
  readonly inThread: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

let worker: Worker | undefined
let workerUrlOverride: URL | string | undefined
let spawnAttempts = 0
let permanentFallback = false
let shuttingDown = false
let nextRequestId = 1
let lastComputeThreadId = 0
const pending = new Map<number, PendingRequest>()

/**
 * Keep the process alive exactly while an answer is owed, and not one moment longer.
 *
 * Both halves are load-bearing and they pull in opposite directions. An always-referenced Worker keeps the event loop alive forever, so a CLI command that counts one payload would hang on exit. An always-unreferenced one is worse and far subtler: when the pending response is the only thing left on the loop, Node exits before it arrives and the caller's promise never settles — an `await` does not keep a process alive on its own.
 */
const syncWorkerRef = (): void => {
  if (!worker) return
  if (pending.size > 0) worker.ref()
  else worker.unref()
}

/** Settle everything still owed by doing the work here. Slow, but a Worker's death must cost latency, never correctness. */
const drainPendingInThread = (reason: string): void => {
  if (pending.size === 0) return
  consola.warn(`[Tokenizer] ${reason}; counting ${pending.size} in-flight job(s) on the main thread instead`)
  const orphaned = [...pending.values()]
  pending.clear()
  for (const request of orphaned) {
    request.inThread().then(request.resolve, request.reject)
  }
}

const handleWorkerGone = (source: Worker, error: Error): void => {
  // A previous generation's late `exit` must not tear down its replacement.
  if (worker !== source) return
  worker = undefined
  if (shuttingDown) return
  consola.warn(`[Tokenizer] Worker ended unexpectedly: ${error.message}`)
  drainPendingInThread("tokenizer Worker ended unexpectedly")
}

const handleMessage = (response: TokenizerResponse): void => {
  const request = pending.get(response.id)
  // No entry means the request was already settled in-thread after the Worker looked dead, and the Worker then answered anyway. Dropping the late answer is correct; settling twice would not be.
  if (!request) return
  pending.delete(response.id)
  syncWorkerRef()
  lastComputeThreadId = response.threadId
  if (response.ok) request.resolve(response.value)
  else request.reject(new Error(response.error))
}

const ensureWorker = (): Worker | undefined => {
  if (worker) return worker
  if (permanentFallback || shuttingDown) return undefined
  if (spawnAttempts >= MAX_SPAWN_ATTEMPTS) {
    permanentFallback = true
    consola.warn(`[Tokenizer] Giving up on the Worker after ${MAX_SPAWN_ATTEMPTS} attempts; token counting stays on the main thread`)
    return undefined
  }

  spawnAttempts++
  const url = resolveTokenizerWorkerUrl(workerUrlOverride)
  try {
    const spawned = new Worker(url)
    spawned.on("message", handleMessage)
    spawned.on("error", (error: Error) => handleWorkerGone(spawned, error))
    spawned.on("exit", (code: number) => handleWorkerGone(spawned, new Error(`exited with code ${code}`)))
    worker = spawned
    syncWorkerRef()
    return spawned
  } catch (error) {
    consola.warn(`[Tokenizer] Could not start the Worker at ${url.href}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Run one counting job off the main thread, falling back to `inThread` whenever that is not possible.
 *
 * `inThread` is both the fallback and the definition of correctness: it is the same computation the Worker runs, so the two paths cannot drift into disagreeing about what a token count is.
 */
export const runTokenizerJob = async <R>(job: TokenizerJob, inThread: () => Promise<R>): Promise<R> => {
  const active = ensureWorker()
  if (!active) return await inThread()

  const id = nextRequestId++
  return await new Promise<R>((resolve, reject) => {
    // The cast is the one unavoidable seam: a message boundary hands back `unknown`, and the pairing of `job.op` with `inThread`'s return type is what makes it true. Both are supplied together by the four wrappers in `tokenizer.ts`, so they cannot be paired wrongly at a distance.
    pending.set(id, { inThread, resolve: resolve as (value: unknown) => void, reject })
    syncWorkerRef()
    try {
      active.postMessage({ ...job, id })
    } catch (error) {
      // Almost always a `DataCloneError`: something in the payload is not structured-cloneable. The job still has to produce a number, so it runs here.
      pending.delete(id)
      syncWorkerRef()
      consola.warn(`[Tokenizer] Could not hand the job to the Worker: ${error instanceof Error ? error.message : String(error)}`)
      inThread().then(resolve, reject)
    }
  })
}

/**
 * Stop the Worker, settling anything still owed on the main thread first.
 *
 * Called from the shutdown sequence. Termination is not conditional on the queue being empty: an in-flight count must not hold up a handover, and finishing it here costs the shutdown path a few milliseconds at most.
 */
export const shutdownTokenizerWorker = async (): Promise<void> => {
  shuttingDown = true
  const active = worker
  worker = undefined
  drainPendingInThread("tokenizer Worker is shutting down")
  if (active) await active.terminate()
}

/** Everything the client knows about itself, for `/debug` and for tests that need to prove where the counting happened. */
export const getTokenizerWorkerDiagnostics = (): {
  alive: boolean
  pending: number
  spawnAttempts: number
  permanentFallback: boolean
  lastComputeThreadId: number
} => ({
  alive: worker !== undefined,
  pending: pending.size,
  spawnAttempts,
  permanentFallback,
  // 0 is `node:worker_threads`' id for the main thread, and also the value before anything has been counted; a non-zero value is positive evidence that a Worker did the work.
  lastComputeThreadId,
})

/** Point the client at a different Worker entry. Test-only seam: production always resolves its own sibling. */
export const setTokenizerWorkerUrlForTests = (url: URL | string | undefined): void => {
  workerUrlOverride = url
}

/** Return the client to its just-imported state, terminating any Worker it holds. Test-only. */
export const _resetTokenizerClient = async (): Promise<void> => {
  await shutdownTokenizerWorker()
  shuttingDown = false
  spawnAttempts = 0
  permanentFallback = false
  lastComputeThreadId = 0
  workerUrlOverride = undefined
}

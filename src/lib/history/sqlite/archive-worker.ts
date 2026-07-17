export interface ArchiveWorkerControl {
  /** Do not claim another durable work unit once this becomes true. */
  shouldStop(): boolean
  /** Yield to the event loop after a committed unit, then re-read the stop flag. */
  checkpoint(): Promise<boolean>
}

/**
 * Process durable units with bounded concurrency. Each worker claims exactly
 * one unit at a time, completes it, then yields/checks shutdown before claiming
 * another. A stop can leave up to `concurrency` already-claimed units, all of
 * which remain tracked until they settle. A failed unit seals new claims but
 * never orphans its still-running siblings.
 */
export async function runArchiveUnits<Unit, Result>(
  units: ReadonlyArray<Unit>,
  concurrency: number,
  runUnit: (unit: Unit) => Promise<Result>,
  control: ArchiveWorkerControl = archiveWorkerControl,
): Promise<Array<Result>> {
  const results: Array<{ index: number; value: Result }> = []
  const failures: Array<unknown> = []
  let cursor = 0
  let failed = false

  const worker = async (): Promise<void> => {
    while (!failed && !control.shouldStop()) {
      const index = cursor++
      if (index >= units.length) return
      try {
        results.push({ index, value: await runUnit(units[index]) })
      } catch (error) {
        failures.push(error)
        failed = true
        return
      }
      if (await control.checkpoint()) return
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), units.length) }, () => worker()))
  if (failures.length > 0) throw new AggregateError(failures, "Archive work unit batch failed")
  return results.sort((left, right) => left.index - right.index).map(({ value }) => value)
}

const activeWorkers = new Set<Promise<void>>()
let stopRequested = false

export const archiveWorkerControl: ArchiveWorkerControl = {
  shouldStop: () => stopRequested,
  async checkpoint() {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return stopRequested
  },
}

/** Open a new startup maintenance generation. No prior worker may still be live. */
export function beginArchiveBackgroundWork(): void {
  if (activeWorkers.size > 0) throw new Error("[history/archive] cannot begin while a prior worker is active")
  stopRequested = false
}

/** Seal the archive maintenance producer. Existing workers finish only their claimed unit. */
export function stopArchiveBackgroundWork(): void {
  stopRequested = true
}

/** Track one never-throw background service so shutdown can wait for its current unit. */
export function trackArchiveBackgroundWork(work: Promise<void>): Promise<void> {
  const tracked = work.catch(() => undefined).finally(() => activeWorkers.delete(tracked))
  activeWorkers.add(tracked)
  return tracked
}

/** Wait for workers to reach their next durable unit boundary after the producer was sealed. */
export async function drainArchiveBackgroundWork(): Promise<void> {
  while (activeWorkers.size > 0) await Promise.allSettled(activeWorkers)
}

export function isArchiveStopRequested(): boolean {
  return stopRequested
}

export function resetArchiveWorkerForTests(): void {
  stopRequested = false
  activeWorkers.clear()
}

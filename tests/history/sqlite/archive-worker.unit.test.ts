import {
  //
  expect,
  test,
} from "bun:test"

import type { ArchiveWorkerControl } from "~/lib/history/sqlite/archive-worker"

import {
  //
  beginArchiveBackgroundWork,
  drainArchiveBackgroundWork,
  isArchiveStopRequested,
  resetArchiveWorkerForTests,
  runArchiveUnits,
  stopArchiveBackgroundWork,
  trackArchiveBackgroundWork,
} from "~/lib/history/sqlite/archive-worker"

test("cooperative stop finishes the claimed unit and does not claim the next", async () => {
  let stop = false
  const started: Array<number> = []
  const committed: Array<number> = []
  const control: ArchiveWorkerControl = {
    shouldStop: () => stop,
    async checkpoint() {
      await Promise.resolve()
      return stop
    },
  }

  const results = await runArchiveUnits(
    [1, 2, 3],
    1,
    async (unit) => {
      started.push(unit)
      stop = true
      await Promise.resolve()
      committed.push(unit)
      return unit
    },
    control,
  )

  expect(results).toEqual([1])
  expect(started).toEqual([1])
  expect(committed).toEqual([1])
})

test("a new worker generation resumes from durable remaining units", async () => {
  let stop = false
  const committed: Array<number> = []
  const control: ArchiveWorkerControl = {
    shouldStop: () => stop,
    async checkpoint() {
      await Promise.resolve()
      return stop
    },
  }

  await runArchiveUnits(
    [1, 2, 3],
    1,
    async (unit) => {
      committed.push(unit)
      stop = true
      return unit
    },
    control,
  )

  stop = false
  const remaining = [1, 2, 3].filter((unit) => !committed.includes(unit))
  await runArchiveUnits(
    remaining,
    1,
    async (unit) => {
      committed.push(unit)
      return unit
    },
    control,
  )

  expect(committed).toEqual([1, 2, 3])
})

test("shutdown drain waits only for the currently claimed archive unit", async () => {
  resetArchiveWorkerForTests()
  beginArchiveBackgroundWork()
  let commitUnit!: () => void
  const currentUnit = new Promise<void>((resolve) => {
    commitUnit = resolve
  })
  void trackArchiveBackgroundWork(currentUnit)

  stopArchiveBackgroundWork()
  expect(isArchiveStopRequested()).toBe(true)
  let drained = false
  const drain = drainArchiveBackgroundWork().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)

  commitUnit()
  await drain
  expect(drained).toBe(true)
  resetArchiveWorkerForTests()
})

test("one failed unit cannot orphan a still-running sibling", async () => {
  let releaseSlow!: () => void
  const slowBarrier = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  let slowDone = false
  let batchSettled = false
  const batch = runArchiveUnits(
    ["fail", "slow"],
    2,
    async (unit) => {
      if (unit === "fail") throw new Error("poison unit")
      await slowBarrier
      slowDone = true
      return unit
    },
    { shouldStop: () => false, checkpoint: async () => false },
  ).finally(() => {
    batchSettled = true
  })

  await Promise.resolve()
  expect(batchSettled).toBe(false)
  expect(slowDone).toBe(false)

  releaseSlow()
  await expect(batch).rejects.toThrow("Archive work unit batch failed")
  expect(slowDone).toBe(true)
})

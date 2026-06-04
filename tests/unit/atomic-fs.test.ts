/**
 * Tests for atomic JSON persistence primitives.
 *
 * Coverage strategy: deterministic-by-construction. We don't try to crash a
 * real process mid-write (impossible in a test process); instead we exercise
 * the two failure modes by:
 *
 *   1. Partial writes — simulated by stubbing `fs.writeFile` to reject after
 *      partially writing the tmp file. We then assert the target file is
 *      untouched (atomicWriteJson never renames a partial tmp into place).
 *
 *   2. Racing snapshots — fire N concurrent persists with distinct payloads;
 *      assert the LAST caller's payload is what ends up on disk AND the
 *      file is valid JSON (i.e. no interleaved O_TRUNC bytes).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "~/lib/atomic-fs"

let workDir: string

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-fs-test-"))
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

describe("atomicWriteJson", () => {
  test("writes valid JSON and reads back round-trip", async () => {
    const target = path.join(workDir, "data.json")
    await atomicWriteJson(target, { a: 1, b: [2, 3] })

    const raw = await fs.readFile(target, "utf8")
    expect(JSON.parse(raw)).toEqual({ a: 1, b: [2, 3] })
  })

  test("leaves no temp files behind after success", async () => {
    const target = path.join(workDir, "data.json")
    await atomicWriteJson(target, { ok: true })

    const entries = await fs.readdir(workDir)
    expect(entries).toEqual(["data.json"])
  })

  test("overwrites existing file atomically (target stays a valid file throughout)", async () => {
    const target = path.join(workDir, "data.json")
    await atomicWriteJson(target, { v: 1 })
    await atomicWriteJson(target, { v: 2 })

    const raw = await fs.readFile(target, "utf8")
    expect(JSON.parse(raw)).toEqual({ v: 2 })
  })

  test("crash during writeFile leaves the previous target intact", async () => {
    const target = path.join(workDir, "data.json")
    // First write the "previous" file.
    await atomicWriteJson(target, { stable: "v1" })

    // Stub fs.writeFile to fail mid-write — emulates a crash before rename().
    const realWriteFile = fs.writeFile
    let stubCalls = 0
    const stub = mock(
      (filePath: Parameters<typeof fs.writeFile>[0], data: Parameters<typeof fs.writeFile>[1], opts?: unknown) => {
        stubCalls++
        // Touch the tmp file so we can assert it gets cleaned up.
        return realWriteFile(filePath, data, opts as Parameters<typeof fs.writeFile>[2]).then(() => {
          throw new Error("simulated crash mid-write")
        })
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fs as any).writeFile = stub

    try {
      let caught: unknown
      try {
        await atomicWriteJson(target, { stable: "v2-attempted" })
      } catch (err) {
        caught = err
      }
      expect((caught as Error | undefined)?.message).toBe("simulated crash mid-write")
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(fs as any).writeFile = realWriteFile
    }

    expect(stubCalls).toBe(1)
    // Target file is unchanged (the previous, valid content).
    const raw = await fs.readFile(target, "utf8")
    expect(JSON.parse(raw)).toEqual({ stable: "v1" })
    // Temp file was cleaned up.
    const entries = await fs.readdir(workDir)
    expect(entries).toEqual(["data.json"])
  })

  test("rejects re-thrown writeFile error and cleans up tmp", async () => {
    const target = path.join(workDir, "data.json")
    const realWriteFile = fs.writeFile
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fs as any).writeFile = mock(() => {
      throw new Error("ENOSPC")
    })

    try {
      let caught: unknown
      try {
        await atomicWriteJson(target, { x: 1 })
      } catch (err) {
        caught = err
      }
      expect((caught as Error | undefined)?.message).toBe("ENOSPC")
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(fs as any).writeFile = realWriteFile
    }

    // Target does not exist (we never had a previous file).
    let accessErr: unknown
    try {
      await fs.access(target)
    } catch (err) {
      accessErr = err
    }
    expect(accessErr).toBeInstanceOf(Error)
  })
})

describe("createSerializedAsyncFn", () => {
  test("serializes overlapping calls in invocation order", async () => {
    const sequence: Array<string> = []
    const work = createSerializedAsyncFn(async (label: string, delayMs: number) => {
      sequence.push(`start:${label}`)
      await new Promise((r) => setTimeout(r, delayMs))
      sequence.push(`end:${label}`)
      return label
    })

    const results = await Promise.all([work("A", 30), work("B", 5), work("C", 1)])

    // Even though B and C have shorter delays, they must wait for A to finish.
    expect(sequence).toEqual(["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"])
    expect(results).toEqual(["A", "B", "C"])
  })

  test("rejection in one call does not poison subsequent calls", async () => {
    const work = createSerializedAsyncFn(async (n: number) => {
      // Tiny await to satisfy require-await; semantics unchanged because
      // createSerializedAsyncFn awaits the returned promise regardless.
      await Promise.resolve()
      if (n === 2) throw new Error("boom")
      return n * 10
    })

    const p1 = work(1)
    const p2 = work(2)
    const p3 = work(3)

    const r1 = await p1
    expect(r1).toBe(10)
    let caught: unknown
    try {
      await p2
    } catch (err) {
      caught = err
    }
    expect((caught as Error | undefined)?.message).toBe("boom")
    const r3 = await p3
    expect(r3).toBe(30)
  })

  test("concurrent atomic writes through serialized chain produce the last payload, valid JSON", async () => {
    const target = path.join(workDir, "racing.json")
    const persist = createSerializedAsyncFn((payload: Record<string, unknown>) => atomicWriteJson(target, payload))

    // 50 concurrent writes with monotonically increasing values; final state
    // must be {n: 49} AND the on-disk JSON must always be parseable.
    const promises: Array<Promise<void>> = []
    for (let i = 0; i < 50; i++) promises.push(persist({ n: i }))
    await Promise.all(promises)

    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as { n: number }
    expect(parsed.n).toBe(49)
  })

  test("without serialization, last-invoked write is NOT guaranteed to win (regression guard)", async () => {
    // Documents the failure mode the helper exists to prevent. With raw
    // atomicWriteJson and reverse-staggered delays (first call sleeps longest),
    // the LAST-INVOKED call (n=2) is the FIRST to attempt the write, so an
    // earlier-invoked but later-completing call's older snapshot can overwrite
    // it. The key invariant is "last invocation is not guaranteed to win" —
    // we deliberately don't pin which earlier value lands to keep the test
    // resilient to CI scheduling jitter.
    const target = path.join(workDir, "racing-raw.json")
    const slowWrite = async (n: number, delayMs: number) => {
      await new Promise((r) => setTimeout(r, delayMs))
      await atomicWriteJson(target, { n })
    }

    await Promise.all([slowWrite(0, 30), slowWrite(1, 15), slowWrite(2, 0)])

    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as { n: number }
    // The slowest-scheduled call (n=0) finishes last and overwrites later-
    // invoked calls. Loose assertion: not n=2 (which serialized version would
    // guarantee). Allows n=0 or n=1 depending on scheduler.
    expect(parsed.n).not.toBe(2)
  })
})

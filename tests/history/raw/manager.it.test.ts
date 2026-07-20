import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  //
  acquireRawCaptureLease,
  configureRawCapture,
  getRawCaptureStatus,
  resetRawCaptureManagerForTests,
} from "~/lib/history/raw/manager"

let dir: string | undefined

afterEach(() => {
  resetRawCaptureManagerForTests()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("RawCaptureManager generations", () => {
  test("keeps in-flight operations on their frozen generation across path rotation", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-raw-rotate-"))
    const firstPath = path.join(dir, "raw-a.db")
    const secondPath = path.join(dir, "raw-b.db")
    expect(configureRawCapture({ enabled: true, dbPath: firstPath, maxObjectBytes: 1024 })).toBe(true)
    const first = acquireRawCaptureLease()
    const firstStore = first.storeId

    expect(configureRawCapture({ enabled: true, dbPath: secondPath, maxObjectBytes: 1024 })).toBe(true)
    const second = acquireRawCaptureLease()
    expect(second.storeId).not.toBe(firstStore)
    expect(first.putObject(new TextEncoder().encode("old generation"), "client-ingress")).toMatchObject({ storeId: firstStore, capability: "available" })
    expect(getRawCaptureStatus()).toMatchObject({ generations: 2, leasedOperations: 2 })

    first.release()
    expect(getRawCaptureStatus()).toMatchObject({ generations: 1, leasedOperations: 1 })
    second.release()
  })

  test("disable affects only new operations while an old lease drains", () => {
    expect(configureRawCapture({ enabled: true, dbPath: ":memory:", maxObjectBytes: 1024 })).toBe(true)
    const old = acquireRawCaptureLease()
    expect(configureRawCapture({ enabled: false, dbPath: "", maxObjectBytes: 1024 })).toBe(true)
    const fresh = acquireRawCaptureLease()

    expect(fresh.requested).toBe(false)
    expect(fresh.putObject(new Uint8Array([1]), "frame")).toEqual({ capability: "not-requested", status: "disabled" })
    expect(old.putObject(new Uint8Array([1]), "frame")).toMatchObject({ capability: "available" })
    old.release()
    expect(getRawCaptureStatus().generations).toBe(0)
  })

  test("same-path hot reload keeps a leased old handle tracked until release", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-raw-same-path-"))
    const dbPath = path.join(dir, "raw.db")
    expect(configureRawCapture({ enabled: true, dbPath, maxObjectBytes: 1024 })).toBe(true)
    const old = acquireRawCaptureLease()
    expect(configureRawCapture({ enabled: true, dbPath, maxObjectBytes: 2048 })).toBe(true)
    const fresh = acquireRawCaptureLease()

    expect(fresh.storeId).toBe(old.storeId)
    expect(getRawCaptureStatus()).toMatchObject({ generations: 2, leasedOperations: 2 })
    old.release()
    expect(getRawCaptureStatus()).toMatchObject({ generations: 1, leasedOperations: 1 })
    fresh.release()
  })

  test("deduplicates exact bytes and records explicit oversize gaps", () => {
    expect(configureRawCapture({ enabled: true, dbPath: ":memory:", maxObjectBytes: 3 })).toBe(true)
    const lease = acquireRawCaptureLease()
    const first = lease.putObject(new Uint8Array([1, 2, 3]), "frame")
    const second = lease.putObject(new Uint8Array([1, 2, 3]), "frame")
    expect(first).toEqual(second)
    expect(lease.putObject(new Uint8Array([1, 2, 3, 4]), "frame")).toMatchObject({ capability: "unavailable", status: "too-large" })
    expect(getRawCaptureStatus()).toMatchObject({ capturedObjects: 1, captureGaps: 1 })
    lease.release()
  })

  test("failed rotation preserves the currently active generation", () => {
    expect(configureRawCapture({ enabled: true, dbPath: ":memory:", maxObjectBytes: 1024 })).toBe(true)
    const original = acquireRawCaptureLease()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-raw-fail-"))
    const unowned = path.join(dir, "unowned.db")
    fs.writeFileSync(unowned, "not sqlite")

    expect(configureRawCapture({ enabled: true, dbPath: unowned, maxObjectBytes: 1024 })).toBe(false)
    const next = acquireRawCaptureLease()
    expect(next.storeId).toBe(original.storeId)
    expect(getRawCaptureStatus().lastError).toBeDefined()
    original.release()
    next.release()
  })
})

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
  createOwnerManifest,
  readOwnerManifest,
} from "~/lib/diagnostics/file/owner-manifest"
import { sweepDiagnosticRetention } from "~/lib/diagnostics/file/retention"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fresh(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-owner-"))
  dirs.push(directory)
  return directory
}

describe("diagnostic owner retention", () => {
  test("manifest is durable-shaped and a live owner is never deleted", () => {
    const directory = fresh()
    const baseName = `copilot-api-${Date.now()}-${process.pid}`
    const manifestPath = createOwnerManifest(directory, { pid: process.pid, bootTime: Date.now(), version: "test" }, baseName)
    const segment = path.join(directory, `${baseName}.ndjson`)
    fs.writeFileSync(segment, "x\n", { mode: 0o600 })
    fs.utimesSync(segment, new Date(0), new Date(0))

    expect(readOwnerManifest(manifestPath)?.pid).toBe(process.pid)
    expect(sweepDiagnosticRetention(directory, 1)).toEqual({ deletedSegments: 0, deletedManifests: 0, retainedUnknownOwners: 1 })
    expect(fs.existsSync(segment)).toBe(true)
  })

  test("dead owner expired segments and its manifest are removed", () => {
    const directory = fresh()
    const baseName = `copilot-api-1-99999999`
    const manifestPath = createOwnerManifest(directory, { pid: 99_999_999, bootTime: 1, version: "test" }, baseName)
    const segment = path.join(directory, `${baseName}.ndjson`)
    fs.writeFileSync(segment, "x\n", { mode: 0o600 })
    fs.utimesSync(segment, new Date(0), new Date(0))

    expect(sweepDiagnosticRetention(directory, 1)).toEqual({ deletedSegments: 1, deletedManifests: 1, retainedUnknownOwners: 0 })
    expect(fs.existsSync(segment)).toBe(false)
    expect(fs.existsSync(manifestPath)).toBe(false)
  })

  test("missing or corrupt owner manifests retain unknown artifacts", () => {
    const directory = fresh()
    fs.writeFileSync(path.join(directory, "broken.owner.json"), "not json")
    expect(sweepDiagnosticRetention(directory, 1).retainedUnknownOwners).toBe(1)
  })
})

import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { listDiagnosticSegments } from "~/lib/diagnostics/file/segment-files"

const dirs: Array<string> = []
afterEach(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

test("segment discovery follows the pino-roll artifact stem boundary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-segments-"))
  dirs.push(directory)
  const baseName = path.join(directory, "copilot-api-123-456.ndjson")
  const expected = [baseName, path.join(directory, "copilot-api-123-456.2026-07-18.1.ndjson")]
  for (const file of expected) fs.writeFileSync(file, "")
  fs.writeFileSync(path.join(directory, "copilot-api-123-4567.2026-07-18.1.ndjson"), "")
  fs.writeFileSync(path.join(directory, "copilot-api-123-456.backup.ndjson"), "")
  fs.writeFileSync(path.join(directory, "copilot-api-123-456.owner.json"), "")
  fs.mkdirSync(path.join(directory, "copilot-api-123-456.fake.ndjson"))

  expect(listDiagnosticSegments(baseName).sort()).toEqual(expected.sort())
})

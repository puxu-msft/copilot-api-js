import {
  //
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..", "..")

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("StructuredFileSink delegates durability instead of owning backend flush or fsync", () => {
  const sink = source("src/lib/diagnostics/file/structured-file-sink.ts")
  const writer = source("src/lib/diagnostics/file/durable-writer.ts")

  expect(sink).toContain('import { DurableFileWriter } from "./durable-writer"')
  expect(sink).toContain("new DurableFileWriter(")
  expect(sink).not.toMatch(/destination\.flush|destination\.end|fsyncSegments|takeDirtyPaths/)

  expect(writer).toContain("flushDestination(")
  expect(writer).toContain("syncStableSegments(")
  expect(writer).toContain("directory.sync()")
})

test("the full-session WAL remains the sole production bus owner", () => {
  const facade = source("src/lib/diagnostics/file/index.ts")
  const spool = source("src/lib/diagnostics/file/bootstrap-spool.ts")

  expect(facade).toContain("spool?.setMirror((record) => sink.writeRecord(record))")
  expect(facade).toContain("spool?.retireDurably()")
  expect(facade).toContain("spool?.removeDurably()")
  expect(spool).toContain("this.mirror?.({ ...record, delivery:")
})

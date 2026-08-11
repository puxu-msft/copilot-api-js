import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { parseDiscoveryBaseline } from "../../scripts/entry-evidence-schema"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const BASELINE_PATH = path.join(REPO_ROOT, "tests/infra/entry-test-discovery-baseline.json")

describe("entry evidence discovery baseline v1", () => {
  test("tracks the current backend discovery population", () => {
    const baseline = parseDiscoveryBaseline(readFileSync(BASELINE_PATH, "utf8"))
    const discovered = new Set<string>()
    for (const suffix of ["unit", "it", "http"]) {
      for (const candidate of new Bun.Glob(`**/*.${suffix}.test.ts`).scanSync({ cwd: path.join(REPO_ROOT, "tests"), onlyFiles: true }))
        discovered.add(`tests/${candidate}`)
    }
    const files = [...discovered].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))

    expect(baseline.files).toEqual(files)
  })

  test("accepts canonical testcase and suite skip union entries", () => {
    const raw =
      JSON.stringify(
        {
          schema_version: 1,
          runner_git_blob: "a".repeat(40),
          minimum_executed: 1,
          files: ["tests/a.unit.test.ts"],
          allowed_skipped: [
            { kind: "suite", file: "tests/a.unit.test.ts", suite_name: "suite", count: 1, reason: "whole-suite-skip" },
            { kind: "testcase", file: "tests/a.unit.test.ts", classname: "class", name: "case", ordinal: 1, count: 1, reason: "todo" },
          ],
        },
        null,
        2,
      ) + "\n"

    expect(parseDiscoveryBaseline(raw).allowed_skipped).toHaveLength(2)
  })

  test("rejects a semantically valid baseline with non-canonical JSON bytes", () => {
    const raw = `{"schema_version":1,"runner_git_blob":"${"a".repeat(40)}","minimum_executed":1,"files":["tests/a.unit.test.ts"],"allowed_skipped":[]}\n`

    expect(() => parseDiscoveryBaseline(raw)).toThrow("raw bytes are not canonical")
  })

  test("rejects todo as a suite skip reason", () => {
    const raw =
      JSON.stringify(
        {
          schema_version: 1,
          runner_git_blob: "a".repeat(40),
          minimum_executed: 1,
          files: ["tests/a.unit.test.ts"],
          allowed_skipped: [{ kind: "suite", file: "tests/a.unit.test.ts", suite_name: "suite", count: 1, reason: "todo" }],
        },
        null,
        2,
      ) + "\n"

    expect(() => parseDiscoveryBaseline(raw)).toThrow("suite skip reason is invalid")
  })

  test("rejects a suite skip that fabricates testcase fields", () => {
    const raw =
      JSON.stringify(
        {
          schema_version: 1,
          runner_git_blob: "a".repeat(40),
          minimum_executed: 1,
          files: ["tests/a.unit.test.ts"],
          allowed_skipped: [{ kind: "suite", file: "tests/a.unit.test.ts", suite_name: "suite", classname: "forbidden", count: 1, reason: "whole-suite-skip" }],
        },
        null,
        2,
      ) + "\n"

    expect(() => parseDiscoveryBaseline(raw)).toThrow("suite skip has unexpected fields")
  })
})

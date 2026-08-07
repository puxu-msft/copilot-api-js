import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { compareFileIdentities, parseJUnit } from "../../scripts/parallel-test-artifacts"

const BUN_JUNIT_CORPUS = path.join(import.meta.dir, "fixtures/bun-junit-shard-14.xml")

describe("parallel-test JUnit artifact parsing", () => {
  test("preserves identities from a frozen Bun JUnit shard corpus", () => {
    const identities = parseJUnit(readFileSync(BUN_JUNIT_CORPUS, "utf8"), "/repo")

    expect(identities.files).toEqual(expect.arrayContaining(["tests/usage-data-shape.unit.test.ts", "tests/models/openai-models-extended.http.test.ts"]))
    expect(identities.files).toHaveLength(48)
    expect(identities.executed).toBe(443)
    expect(identities.skipped).toBe(2)
    expect(identities.skippedIdentities).toEqual([
      {
        kind: "testcase",
        file: "tests/history/search/daemon-entry-status.it.test.ts",
        classname: "runHistorySearchDaemon&apos;s tail-progress status (merged-state review blocker 3, 2026-07-22)",
        name: "lastSuccessfulTailAt becomes non-null after the daemon's initial catch-up tail round, before any client search has ever been issued",
        ordinal: 1,
        count: 1,
      },
      {
        kind: "testcase",
        file: "tests/history/search/daemon-entry-status.it.test.ts",
        classname: "runHistorySearchDaemon&apos;s tail-progress status (merged-state review blocker 3, 2026-07-22)",
        name: "poisonedCount reflects a real poisoned row committed BEFORE the daemon starts (its initial catch-up tail must still isolate it, per B1)",
        ordinal: 1,
        count: 1,
      },
    ])
  })

  test("reports the concrete disk file removed after balancing", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase classname="suite" name="case" file="/repo/tests/kept.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(compareFileIdentities(["tests/kept.unit.test.ts", "tests/missing.unit.test.ts"], identities.files)).toEqual({
      missing: ["tests/missing.unit.test.ts"],
      unexpected: [],
    })
  })

  test("retains a whole-suite skipped file that has no testcase rows", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="tests/native.unit.test.ts" file="tests/native.unit.test.ts" tests="0" skipped="2"/></testsuites>`,
      "/repo",
    )

    expect(identities.files).toEqual(["tests/native.unit.test.ts"])
    expect(identities.skipped).toBe(2)
    expect(identities.skippedIdentities).toEqual([{ kind: "suite", file: "tests/native.unit.test.ts", suite_name: "tests/native.unit.test.ts", count: 2 }])
  })

  test("does not treat a passing suite's skipped assertion count as a whole-suite skip", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="tests/passing.unit.test.ts" file="tests/passing.unit.test.ts" tests="1" skipped="1"><testcase classname="suite" name="passes" file="tests/passing.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.skippedIdentities).toEqual([])
  })

  test("does not reinterpret a paired suite without testcase rows as a whole-suite skip", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="tests/empty.unit.test.ts" file="tests/empty.unit.test.ts" skipped="1"></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities).toEqual({ files: ["tests/empty.unit.test.ts"], executed: 0, skipped: 0, skippedIdentities: [] })
  })

  test("ignores a well-formed testcase row without the legacy identity fields", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase file="tests/incomplete.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities).toEqual({ files: [], executed: 0, skipped: 0, skippedIdentities: [] })
  })

  test("keeps a runnable testcase whose classname and name are legitimate empty strings", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase classname="" name="" file="/repo/tests/empty.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.files).toEqual(["tests/empty.unit.test.ts"])
    expect(identities.executed).toBe(1)
  })

  test("assigns ordinal and skip identity from real JUnit testcase rows", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase classname="suite" name="same" file="/repo/tests/a.unit.test.ts"/><testcase classname="suite" name="same" file="/repo/tests/a.unit.test.ts"><skipped/></testcase></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.executed).toBe(1)
    expect(identities.skipped).toBe(1)
    expect(identities.skippedIdentities).toEqual([{ kind: "testcase", file: "tests/a.unit.test.ts", classname: "suite", name: "same", ordinal: 2, count: 1 }])
  })

  test("rejects unbound namespace prefixes rather than accepting malformed XML", () => {
    expect(() => parseJUnit(`<testsuites><j:testsuite name="suite" file="tests/a.unit.test.ts"/></testsuites>`, "/repo")).toThrow()
  })

  test("parses multiline namespaced JUnit tags and numeric XML entities", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?>
<testsuites xmlns:j="urn:junit">
  <testsuite
    skipped="0"
    file="/repo/tests/numeric&#x2D;entity.unit.test.ts"
    name="suite">
    <j:testcase
      name="same&#32;case"
      file="/repo/tests/numeric&#x2D;entity.unit.test.ts"
      classname="suite&#x20;name" />
    <j:testcase file="/repo/tests/numeric&#x2D;entity.unit.test.ts" classname="suite&#x20;name" name="same&#32;case"><j:skipped /></j:testcase>
  </testsuite>
</testsuites>`,
      "/repo",
    )

    expect(identities).toEqual({
      files: ["tests/numeric-entity.unit.test.ts"],
      executed: 1,
      skipped: 1,
      skippedIdentities: [{ kind: "testcase", file: "tests/numeric-entity.unit.test.ts", classname: "suite name", name: "same case", ordinal: 2, count: 1 }],
    })
  })

  test("rejects malformed or truncated JUnit rather than returning a partial identity", () => {
    expect(() => parseJUnit(`<testsuites><testsuite file="tests/a.unit.test.ts"><testcase file="tests/a.unit.test.ts"`, "/repo")).toThrow()
  })
})

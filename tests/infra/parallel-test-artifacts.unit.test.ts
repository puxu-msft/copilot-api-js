import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  //
  compareFileIdentities,
  formatTallyLine,
  parseJUnit,
} from "../../scripts/parallel-test-artifacts"

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

    expect(identities).toEqual({ files: ["tests/empty.unit.test.ts"], executed: 0, skipped: 0, skippedIdentities: [], failed: 0, failedIdentities: [] })
  })

  test("ignores a well-formed testcase row without the legacy identity fields", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase file="tests/incomplete.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities).toEqual({ files: [], executed: 0, skipped: 0, skippedIdentities: [], failed: 0, failedIdentities: [] })
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
      failed: 0,
      failedIdentities: [],
    })
  })

  // The tally the delivery report quotes used to come from the shards' stdout, which reads
  // `0 fail` whenever a shard dies while printing its summary — the `N fail` line never
  // lands, but this row was already flushed. These two cases are what make the XML the
  // authority instead.
  test("counts a failing testcase from its <failure> child and keeps it inside executed", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="asserts" file="/repo/tests/a.unit.test.ts"><failure type="AssertionError">expected 1 to be 2</failure></testcase><testcase classname="suite" name="passes" file="/repo/tests/a.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.executed).toBe(2)
    expect(identities.failed).toBe(1)
    expect(identities.failedIdentities).toEqual([{ file: "tests/a.unit.test.ts", classname: "suite", name: "asserts", ordinal: 1, type: "AssertionError" }])
  })

  test("counts an <error> child (thrown / timed out) as a failure too", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="times out" file="/repo/tests/a.unit.test.ts"><error type="TimeoutError"/></testcase></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.failed).toBe(1)
    expect(identities.failedIdentities).toEqual([{ file: "tests/a.unit.test.ts", classname: "suite", name: "times out", ordinal: 1, type: "TimeoutError" }])
  })

  test("a skipped testcase is never counted as failed", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="skips" file="/repo/tests/a.unit.test.ts"><skipped/></testcase></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.skipped).toBe(1)
    expect(identities.failed).toBe(0)
    expect(identities.failedIdentities).toEqual([])
  })

  test("rejects malformed or truncated JUnit rather than returning a partial identity", () => {
    expect(() => parseJUnit(`<testsuites><testsuite file="tests/a.unit.test.ts"><testcase file="tests/a.unit.test.ts"`, "/repo")).toThrow()
  })

  // Dropping an unidentifiable row is deliberate (a legacy shape must not crash the run),
  // but dropping it SILENTLY is the exact failure this module exists to prevent: the file
  // still appears on both sides of the identity comparison, every shard exits 0, and the
  // counts are simply low. Comparing against the producer's declared totals surfaces that
  // without enumerating malformed shapes.
  //
  // What these cases do NOT establish: the declared totals and the rows come from the same
  // producer into the same artifact, so this is producer-relative self-consistency -- it
  // catches OUR parser dropping rows, and cannot catch the producer omitting a file from
  // both its rows and its totals (which is what a load-time throw does).
  test("throws when the parse disagrees with the document's own declared totals", () => {
    const xml = `<?xml version="1.0"?><testsuites tests="2" failures="0" skipped="0"><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="counted" file="/repo/tests/a.unit.test.ts"/><testcase name="no classname" file="/repo/tests/a.unit.test.ts"/></testsuite></testsuites>`

    expect(() => parseJUnit(xml, "/repo")).toThrow(/JUnit self-inconsistency: parsed 1 rows.*declares 2 tests/s)
  })

  test("accepts a document whose declared totals match the parse", () => {
    const xml = `<?xml version="1.0"?><testsuites tests="2" failures="1" skipped="0"><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="passes" file="/repo/tests/a.unit.test.ts"/><testcase classname="suite" name="fails" file="/repo/tests/a.unit.test.ts"><failure type="AssertionError"/></testcase></testsuite></testsuites>`

    const identities = parseJUnit(xml, "/repo")
    expect(identities.executed).toBe(2)
    expect(identities.failed).toBe(1)
  })

  test("declared skips are reconciled too, so a dropped skip row cannot hide", () => {
    const xml = `<?xml version="1.0"?><testsuites tests="2" failures="0" skipped="1"><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="runs" file="/repo/tests/a.unit.test.ts"/><testcase classname="suite" name="skips" file="/repo/tests/a.unit.test.ts"><skipped/></testcase></testsuite></testsuites>`

    const identities = parseJUnit(xml, "/repo")
    expect(identities.executed).toBe(1)
    expect(identities.skipped).toBe(1)
  })

  // One case per arm, because the three arms fail independently. Without these, deleting
  // either the `failures` or the `skipped` comparison left the suite green -- the row count
  // matched, so only the `tests` arm was ever exercised and the other two were decoration.
  test("a row-count match does not excuse a failure-count mismatch", () => {
    const xml = `<?xml version="1.0"?><testsuites tests="1" failures="1" skipped="0"><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="passes" file="/repo/tests/a.unit.test.ts"/></testsuite></testsuites>`

    expect(() => parseJUnit(xml, "/repo")).toThrow(/parsed 1 rows \/ 0 failed.*declares 1 tests \/ 1 failures/s)
  })

  test("a row-count match does not excuse a skip-count mismatch", () => {
    const xml = `<?xml version="1.0"?><testsuites tests="1" failures="0" skipped="1"><testsuite name="suite" file="/repo/tests/a.unit.test.ts"><testcase classname="suite" name="runs" file="/repo/tests/a.unit.test.ts"/></testsuite></testsuites>`

    expect(() => parseJUnit(xml, "/repo")).toThrow(/0 skipped.*declares 1 tests \/ 0 failures \/ 1 skipped/s)
  })

  test("stays silent when the producer declares no totals — the check is conditional, not universal", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase file="tests/incomplete.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.executed).toBe(0)
  })
})

// The tally line is what a delivery report quotes, so every way the counts can be wrong
// has to be visible ON it. A file that throws at load time produces no JUnit rows at all
// while bun still prints its own `N fail`, so the crashed-shard heuristic does not fire and
// that file's tests vanish from every count here -- the exit code stays fail-closed via the
// file-identity check, but the line itself would read green.
describe("formatTallyLine", () => {
  const base = { shards: 16, executed: 100, failed: 0, skipped: 3, crashedShards: 0, missingFiles: 0, unexpectedFiles: 0, wallSeconds: "12.34" }

  test("derives pass from executed - failed so the two can never disagree", () => {
    expect(formatTallyLine({ ...base, executed: 100, failed: 7 })).toContain("100 tests · 93 pass · 7 fail · 100 executed")
  })

  test("says nothing extra when every discovered file reported rows", () => {
    const line = formatTallyLine(base)
    expect(line).toContain("100 pass · 0 fail")
    expect(line).not.toContain("INCOMPLETE")
    expect(line).not.toContain("OUT-OF-SCOPE")
    expect(line).not.toContain("crashed")
  })

  test("marks the tally itself incomplete when a file produced no JUnit rows", () => {
    const line = formatTallyLine({ ...base, missingFiles: 2 })
    expect(line).toContain("INCOMPLETE: 2 file(s) produced no JUnit rows")
    expect(line).toContain("a floor, not a total")
  })

  // The first version marked only `missing`, so an unexpected-only mismatch exited 1 while
  // the tally line still read clean -- the one line a report quotes said nothing was wrong.
  test("marks the tally out-of-scope when an undiscovered file reported rows", () => {
    const line = formatTallyLine({ ...base, unexpectedFiles: 1 })
    expect(line).toContain("OUT-OF-SCOPE: 1 undiscovered file(s) reported rows")
    expect(line).not.toContain("INCOMPLETE")
  })

  test("reports both directions of an identity mismatch at once", () => {
    const line = formatTallyLine({ ...base, missingFiles: 2, unexpectedFiles: 1 })
    expect(line).toContain("INCOMPLETE: 2 file(s)")
    expect(line).toContain("OUT-OF-SCOPE: 1 undiscovered file(s)")
  })

  test("reports a crashed shard and an incomplete tally independently", () => {
    const line = formatTallyLine({ ...base, crashedShards: 1, missingFiles: 1 })
    expect(line).toContain("1 shard(s) crashed")
    expect(line).toContain("INCOMPLETE: 1 file(s)")
  })
})

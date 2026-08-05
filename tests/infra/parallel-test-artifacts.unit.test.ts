import { describe, expect, test } from "bun:test"

import { compareFileIdentities, parseJUnit } from "../../scripts/parallel-test-artifacts"

describe("parallel-test JUnit artifact parsing", () => {
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

  test("assigns ordinal and skip identity from real JUnit testcase rows", () => {
    const identities = parseJUnit(
      `<?xml version="1.0"?><testsuites><testsuite name="suite"><testcase classname="suite" name="same" file="/repo/tests/a.unit.test.ts"/><testcase classname="suite" name="same" file="/repo/tests/a.unit.test.ts"><skipped/></testcase></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.executed).toBe(1)
    expect(identities.skipped).toBe(1)
    expect(identities.skippedIdentities).toEqual([{ file: "tests/a.unit.test.ts", classname: "suite", name: "same", ordinal: 2, count: 1 }])
  })
})

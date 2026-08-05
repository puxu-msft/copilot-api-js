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
      `<?xml version="1.0"?><testsuites><testsuite name="tests/passing.unit.test.ts" file="tests/passing.unit.test.ts" tests="1" skipped="0"><testcase classname="suite" name="passes" file="tests/passing.unit.test.ts"/></testsuite></testsuites>`,
      "/repo",
    )

    expect(identities.skippedIdentities).toEqual([])
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
})

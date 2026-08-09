import {
  //
  SaxesParser,
  type SaxesTagNS,
} from "saxes"

export interface TestcaseSkippedIdentity {
  kind: "testcase"
  file: string
  classname: string
  name: string
  ordinal: number
  count: number
}

export interface SuiteSkippedIdentity {
  kind: "suite"
  file: string
  suite_name: string
  count: number
}

export type SkippedIdentity = TestcaseSkippedIdentity | SuiteSkippedIdentity

export interface FailedIdentity {
  file: string
  classname: string
  name: string
  ordinal: number
  type: string
}

export interface JUnitIdentities {
  files: Array<string>
  executed: number
  skipped: number
  skippedIdentities: Array<SkippedIdentity>
  failed: number
  failedIdentities: Array<FailedIdentity>
}

const IDENTITY_SEPARATOR = String.fromCodePoint(0)

type OpenSuite = { kind: "suite"; file?: string; name?: string; skipped: number; testcaseCount: number; selfClosing: boolean }
type OpenTestcase = { kind: "testcase"; file: string; classname: string; name: string; ordinal: number; skipped: boolean; failure?: string }
type OpenElement = OpenSuite | OpenTestcase | { kind: "other" }

function toRepoRelative(file: string, repoRoot: string): string {
  const prefix = `${repoRoot}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function attributeValue(attributes: SaxesTagNS["attributes"], name: string): string | undefined {
  if (!Object.hasOwn(attributes, name)) return undefined
  return (attributes as Record<string, { value: string } | undefined>)[name]?.value
}

function testcaseKey(file: string, classname: string, name: string, ordinal?: number): string {
  return ["testcase", file, classname, name, ordinal].filter((part) => part !== undefined).join(IDENTITY_SEPARATOR)
}

function skippedIdentityKey(identity: SkippedIdentity): string {
  return identity.kind === "testcase" ?
      testcaseKey(identity.file, identity.classname, identity.name, identity.ordinal)
    : ["suite", identity.file, identity.suite_name].join(IDENTITY_SEPARATOR)
}

export function parseJUnit(xml: string, repoRoot: string): JUnitIdentities {
  const files = new Set<string>()
  const ordinals = new Map<string, number>()
  const skipped = new Map<string, SkippedIdentity>()
  const failedIdentities: Array<FailedIdentity> = []
  const elements: Array<OpenElement> = []
  let executed = 0
  let skippedCount = 0
  let failedCount = 0
  const parser = new SaxesParser({ xmlns: true })

  parser.on("opentag", (tag: SaxesTagNS) => {
    const { attributes, local: name } = tag
    if (name === "testsuite") {
      const rawFile = attributeValue(attributes, "file")
      const file = rawFile === undefined ? undefined : toRepoRelative(rawFile, repoRoot)
      if (file !== undefined) files.add(file)
      const skippedAttribute = attributeValue(attributes, "skipped")
      const skippedValue = skippedAttribute === undefined ? 0 : Number(skippedAttribute)
      elements.push({
        kind: "suite",
        file,
        name: attributeValue(attributes, "name"),
        skipped: Number.isSafeInteger(skippedValue) && skippedValue > 0 ? skippedValue : 0,
        testcaseCount: 0,
        selfClosing: tag.isSelfClosing,
      })
      return
    }
    if (name === "testcase") {
      const rawFile = attributeValue(attributes, "file")
      const rawClassname = attributeValue(attributes, "classname")
      const rawName = attributeValue(attributes, "name")
      if (rawFile === undefined || rawClassname === undefined || rawName === undefined) {
        elements.push({ kind: "other" })
        return
      }
      const file = toRepoRelative(rawFile, repoRoot)
      files.add(file)
      const key = testcaseKey(file, rawClassname, rawName)
      const ordinal = (ordinals.get(key) ?? 0) + 1
      ordinals.set(key, ordinal)
      for (const element of elements) if (element.kind === "suite") element.testcaseCount += 1
      elements.push({ kind: "testcase", file, classname: rawClassname, name: rawName, ordinal, skipped: false })
      return
    }
    if (name === "skipped") {
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index]
        if (element.kind === "testcase") {
          element.skipped = true
          break
        }
      }
    }
    // A failing testcase carries a `<failure>` (assertion) or `<error>` (thrown/timeout)
    // child. Counting them here is what makes the tally independent of the shards' stdout:
    // a shard that dies while printing its summary loses its `N fail` line but has already
    // flushed this row, and parsing the truncated stdout then reports a green `0 fail`.
    if (name === "failure" || name === "error") {
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index]
        if (element.kind === "testcase") {
          element.failure ??= attributeValue(attributes, "type") ?? name
          break
        }
      }
    }
    elements.push({ kind: "other" })
  })

  parser.on("closetag", () => {
    const element = elements.pop()
    if (element === undefined) throw new Error("JUnit element stack underflow")
    if (element.kind === "testcase") {
      if (element.skipped) {
        skippedCount += 1
        const identity: TestcaseSkippedIdentity = {
          kind: "testcase",
          file: element.file,
          classname: element.classname,
          name: element.name,
          ordinal: element.ordinal,
          count: 1,
        }
        skipped.set(skippedIdentityKey(identity), identity)
      } else {
        executed += 1
        // A failed test still ran, so it stays inside `executed`; `failed` is a separate
        // axis, not a subtraction from it.
        if (element.failure !== undefined) {
          failedCount += 1
          failedIdentities.push({
            file: element.file,
            classname: element.classname,
            name: element.name,
            ordinal: element.ordinal,
            type: element.failure,
          })
        }
      }
      return
    }
    // Bun represents a fully skipped file as a self-closing testsuite with no testcase rows.
    if (
      element.kind === "suite"
      && element.selfClosing
      && element.file !== undefined
      && element.name !== undefined
      && element.testcaseCount === 0
      && element.skipped > 0
    ) {
      const identity: SuiteSkippedIdentity = { kind: "suite", file: element.file, suite_name: element.name, count: element.skipped }
      skipped.set(skippedIdentityKey(identity), identity)
      skippedCount += element.skipped
    }
  })

  parser.on("error", (error) => {
    throw error
  })
  parser.write(xml).close()
  if (elements.length > 0) throw new Error("JUnit document ended with unclosed elements")
  return {
    files: [...files].sort(),
    executed,
    skipped: skippedCount,
    skippedIdentities: [...skipped.values()].sort((left, right) => skippedIdentityKey(left).localeCompare(skippedIdentityKey(right))),
    failed: failedCount,
    failedIdentities,
  }
}

export function compareFileIdentities(expected: Array<string>, actual: Array<string>): { missing: Array<string>; unexpected: Array<string> } {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    missing: [...expectedSet].filter((file) => !actualSet.has(file)).sort(),
    unexpected: [...actualSet].filter((file) => !expectedSet.has(file)).sort(),
  }
}

export interface TallyInput {
  shards: number
  executed: number
  failed: number
  skipped: number
  crashedShards: number
  missingFiles: number
  wallSeconds: string
}

/**
 * The one line a delivery report actually quotes, so every way the counts can be
 * wrong has to be visible ON it -- not several lines above it.
 *
 * `missingFiles > 0` means at least one discovered test file produced no JUnit rows
 * at all. A file that throws at load time does exactly that: bun still prints its own
 * `N fail`, so the crashed-shard heuristic does not fire, and that file's tests and
 * failures evaporate from every count here while the line still reads green.
 */
export function formatTallyLine(input: TallyInput): string {
  const passed = input.executed - input.failed
  const crashedNote = input.crashedShards > 0 ? ` · ${input.crashedShards} shard(s) crashed (see isolated re-run above)` : ""
  const incompleteNote =
    input.missingFiles > 0 ?
      ` · ⚠ INCOMPLETE: ${input.missingFiles} file(s) produced no JUnit rows (see "missing runtime file identity" above) — these counts are a floor, not a total`
    : ""
  return (
    `[parallel-test] ${input.shards} shards · ${input.executed} tests · ${passed} pass · ${input.failed} fail`
    + ` · ${input.executed} executed · ${input.skipped} skipped${crashedNote}${incompleteNote} · ${input.wallSeconds}s`
  )
}

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
  // The producer's own declared totals. Used below to check OUR PARSE against them --
  // this is producer-relative self-consistency, NOT an independent oracle (see below).
  let declared: { tests: number; failures: number; skipped: number } | undefined
  let sawRoot = false
  const parser = new SaxesParser({ xmlns: true })

  parser.on("opentag", (tag: SaxesTagNS) => {
    const { attributes, local: name } = tag
    if (name === "testsuites" && !sawRoot) {
      sawRoot = true
      const numeric = (key: string): number | undefined => {
        const raw = attributeValue(attributes, key)
        if (raw === undefined) return undefined
        const value = Number(raw)
        return Number.isSafeInteger(value) && value >= 0 ? value : undefined
      }
      const tests = numeric("tests")
      const failures = numeric("failures")
      const skippedTotal = numeric("skipped")
      if (tests !== undefined && failures !== undefined && skippedTotal !== undefined) {
        declared = { tests, failures, skipped: skippedTotal }
      }
      elements.push({ kind: "other" })
      return
    }
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
  // Check our parse against the producer's own declared totals. Rows this parser cannot
  // identify (a `<testcase>` missing `file`/`classname`/`name`) are dropped on purpose so a
  // legacy shape does not crash the run — but dropping them SILENTLY is the very failure
  // this whole module exists to prevent: the counts come out low and nothing says so.
  //
  // SCOPE, and it is narrower than it looks: the declared attributes and the rows come out
  // of the SAME Bun JUnit producer, into the same artifact. This is therefore a
  // producer-relative self-consistency check -- independent of OUR counting implementation,
  // NOT independent of the producer. If the producer omits a file from both its rows and its
  // declared totals (exactly what a load-time throw does), both sides agree and this passes.
  // It does not establish artifact completeness; nothing here does. Earlier revisions called
  // it an "independent oracle", which was wrong, and was the third same-source claim in this
  // module's history -- independence is decided by what each side traces back to.
  //
  // Enforced only when the producer declares all three, which is another real limit.
  // Measured on 16/16 real bun 1.3.14 shard artifacts: parsed rows === declared `tests`,
  // parsed failures === declared `failures`, parsed skips === declared `skipped`.
  if (declared !== undefined) {
    const rows = executed + skippedCount
    if (rows !== declared.tests || failedCount !== declared.failures || skippedCount !== declared.skipped) {
      throw new Error(
        `[parallel-test] JUnit self-inconsistency: parsed ${rows} rows / ${failedCount} failed / ${skippedCount} skipped, `
          + `but the document declares ${declared.tests} tests / ${declared.failures} failures / ${declared.skipped} skipped. `
          + `Rows were dropped or miscounted; the tally derived from this artifact would be wrong.`,
      )
    }
  }
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
  unexpectedFiles: number
  wallSeconds: string
}

/**
 * The one line a delivery report actually quotes, so every way the counts can be
 * wrong has to be visible ON it -- not several lines above it.
 *
 * Both directions of a discovery/runtime identity mismatch get a marker, because they
 * are wrong in OPPOSITE directions and a reader needs to know which:
 *
 * - `missingFiles > 0` -- a discovered file produced no JUnit rows at all, so the counts
 *   are a floor. A file that throws at load time does exactly that: bun still prints its
 *   own `N fail`, so the crashed-shard heuristic does not fire either.
 * - `unexpectedFiles > 0` -- rows arrived from a file that was never discovered, so the
 *   counts include work outside the intended scope. The first version of this marker
 *   covered only `missing`, which left `unexpected`-only runs exiting 1 while the tally
 *   line still looked clean.
 */
export function formatTallyLine(input: TallyInput): string {
  const passed = input.executed - input.failed
  const crashedNote = input.crashedShards > 0 ? ` · ${input.crashedShards} shard(s) crashed (see isolated re-run above)` : ""
  const missingNote =
    input.missingFiles > 0 ?
      ` · ⚠ INCOMPLETE: ${input.missingFiles} file(s) produced no JUnit rows (see "missing runtime file identity" above) — these counts are a floor, not a total`
    : ""
  const unexpectedNote =
    input.unexpectedFiles > 0 ?
      ` · ⚠ OUT-OF-SCOPE: ${input.unexpectedFiles} undiscovered file(s) reported rows (see "unexpected runtime file identity" above) — these counts cover more than the intended set`
    : ""
  return (
    `[parallel-test] ${input.shards} shards · ${input.executed} tests · ${passed} pass · ${input.failed} fail`
    + ` · ${input.executed} executed · ${input.skipped} skipped${crashedNote}${missingNote}${unexpectedNote} · ${input.wallSeconds}s`
  )
}

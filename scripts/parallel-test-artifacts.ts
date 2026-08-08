import { SaxesParser, type SaxesTagNS } from "saxes"

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

export interface JUnitIdentities {
  files: Array<string>
  executed: number
  skipped: number
  skippedIdentities: Array<SkippedIdentity>
}

const IDENTITY_SEPARATOR = String.fromCharCode(0)

type OpenSuite = { kind: "suite"; file?: string; name?: string; skipped: number; testcaseCount: number; selfClosing: boolean }
type OpenTestcase = { kind: "testcase"; file: string; classname: string; name: string; ordinal: number; skipped: boolean }
type OpenElement = OpenSuite | OpenTestcase | { kind: "other" }

function toRepoRelative(file: string, repoRoot: string): string {
  const prefix = `${repoRoot}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function testcaseKey(file: string, classname: string, name: string, ordinal?: number): string {
  return ["testcase", file, classname, name, ordinal].filter((part) => part !== undefined).join(IDENTITY_SEPARATOR)
}

function skippedIdentityKey(identity: SkippedIdentity): string {
  return identity.kind === "testcase"
    ? testcaseKey(identity.file, identity.classname, identity.name, identity.ordinal)
    : ["suite", identity.file, identity.suite_name].join(IDENTITY_SEPARATOR)
}

export function parseJUnit(xml: string, repoRoot: string): JUnitIdentities {
  const files = new Set<string>()
  const ordinals = new Map<string, number>()
  const skipped = new Map<string, SkippedIdentity>()
  const elements: OpenElement[] = []
  let executed = 0
  let skippedCount = 0
  const parser = new SaxesParser({ xmlns: true })

  parser.on("opentag", (tag: SaxesTagNS) => {
    const { attributes, local: name } = tag
    if (name === "testsuite") {
      const rawFile = attributes.file?.value
      const file = rawFile === undefined ? undefined : toRepoRelative(rawFile, repoRoot)
      if (file !== undefined) files.add(file)
      const skippedAttribute = attributes.skipped?.value
      const skippedValue = skippedAttribute === undefined ? 0 : Number(skippedAttribute)
      elements.push({
        kind: "suite",
        file,
        name: attributes.name?.value,
        skipped: Number.isSafeInteger(skippedValue) && skippedValue > 0 ? skippedValue : 0,
        testcaseCount: 0,
        selfClosing: tag.isSelfClosing,
      })
      return
    }
    if (name === "testcase") {
      const rawFile = attributes.file?.value
      const rawClassname = attributes.classname?.value
      const rawName = attributes.name?.value
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
      } else executed += 1
      return
    }
    // Bun represents a fully skipped file as a self-closing testsuite with no testcase rows.
    if (
      element.kind === "suite" &&
      element.selfClosing &&
      element.file !== undefined &&
      element.name !== undefined &&
      element.testcaseCount === 0 &&
      element.skipped > 0
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
  if (elements.length !== 0) throw new Error("JUnit document ended with unclosed elements")
  return {
    files: [...files].sort(),
    executed,
    skipped: skippedCount,
    skippedIdentities: [...skipped.values()].sort((left, right) => skippedIdentityKey(left).localeCompare(skippedIdentityKey(right))),
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

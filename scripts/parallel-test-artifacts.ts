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

function unescapeXml(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

function attribute(element: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1]
}

function toRepoRelative(file: string, repoRoot: string): string {
  const unescaped = unescapeXml(file)
  const prefix = `${repoRoot}/`
  return unescaped.startsWith(prefix) ? unescaped.slice(prefix.length) : unescaped
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
  let executed = 0
  let skippedCount = 0

  // Bun represents a fully skipped file as a testsuite with no testcase rows. The
  // suite-level file attribute is therefore part of the runtime file identity set.
  for (const suite of xml.matchAll(/<testsuite\b([^>]*)\/?\>/g)) {
    const rawFile = attribute(suite[1], "file")
    const rawName = attribute(suite[1], "name")
    if (!rawFile) continue

    const file = toRepoRelative(rawFile, repoRoot)
    files.add(file)
    if (attribute(suite[1], "tests") !== "0" || attribute(suite[1], "skipped") === "0" || !rawName) continue

    const count = Number(attribute(suite[1], "skipped"))
    if (!Number.isSafeInteger(count) || count <= 0) continue
    const suiteIdentity: SuiteSkippedIdentity = { kind: "suite", file, suite_name: unescapeXml(rawName), count }
    skipped.set(skippedIdentityKey(suiteIdentity), suiteIdentity)
    skippedCount += count
  }

  for (const testcase of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = testcase[1]
    const body = testcase[2] ?? ""
    const rawFile = attribute(attributes, "file")
    const rawClassname = attribute(attributes, "classname")
    const rawName = attribute(attributes, "name")
    if (!rawFile || !rawClassname || !rawName) continue

    const file = toRepoRelative(rawFile, repoRoot)
    const classname = unescapeXml(rawClassname)
    const name = unescapeXml(rawName)
    files.add(file)
    const key = testcaseKey(file, classname, name)
    const ordinal = (ordinals.get(key) ?? 0) + 1
    ordinals.set(key, ordinal)

    if (/<skipped\b/.test(body)) {
      skippedCount += 1
      const testcaseIdentity: TestcaseSkippedIdentity = { kind: "testcase", file, classname, name, ordinal, count: 1 }
      skipped.set(skippedIdentityKey(testcaseIdentity), testcaseIdentity)
    } else {
      executed += 1
    }
  }

  return {
    files: [...files].sort(),
    executed,
    skipped: skippedCount,
    skippedIdentities: [...skipped.values()].sort((a, b) => skippedIdentityKey(a).localeCompare(skippedIdentityKey(b))),
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

export interface SkippedIdentity {
  file: string
  classname: string
  name: string
  ordinal: number
  count: number
}

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

function identityKey(file: string, classname: string, name: string, ordinal?: number): string {
  return [file, classname, name, ordinal].filter((part) => part !== undefined).join(IDENTITY_SEPARATOR)
}

export function parseJUnit(xml: string, repoRoot: string): JUnitIdentities {
  const files = new Set<string>()
  const ordinals = new Map<string, number>()
  const skipped = new Map<string, SkippedIdentity>()
  let executed = 0
  let skippedCount = 0

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
    const key = identityKey(file, classname, name)
    const ordinal = (ordinals.get(key) ?? 0) + 1
    ordinals.set(key, ordinal)

    if (/<skipped\b/.test(body)) {
      skippedCount += 1
      skipped.set(identityKey(file, classname, name, ordinal), { file, classname, name, ordinal, count: 1 })
    } else {
      executed += 1
    }
  }

  return {
    files: [...files].sort(),
    executed,
    skipped: skippedCount,
    skippedIdentities: [...skipped.values()].sort((a, b) =>
      identityKey(a.file, a.classname, a.name, a.ordinal).localeCompare(identityKey(b.file, b.classname, b.name, b.ordinal)),
    ),
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

import {
  //
  expect,
  test,
} from "bun:test"
import {
  //
  readdir,
  readFile,
} from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")

async function sourceFiles(root: string): Promise<Array<string>> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name)
      return (
        entry.isDirectory() ? sourceFiles(resolved)
        : entry.isFile() && entry.name.endsWith(".ts") ? [resolved]
        : []
      )
    }),
  )
  return nested.flat()
}

interface LiteralRemapSite {
  readonly file: string
  readonly expression: string
}

// P1 freezes the pre-existing fixed-offset sites as an exact ratchet baseline. P3M must remove each
// entry as its call site migrates to resolveRemappedFrame; M4's acceptance gate is this list === [].
const LEGACY_LITERAL_REMAP_BASELINE: ReadonlyArray<LiteralRemapSite> = [
  { file: "src/lib/pipeline/driver.ts", expression: ".remap(_, 0)" },
  { file: "src/lib/pipeline/driver.ts", expression: ".remap(frame, 1)" },
  { file: "src/lib/pipeline/driver.ts", expression: ".remap(toWrite, 1)" },
  { file: "src/lib/anthropic/live-reconcile.ts", expression: ".remap(frame, 1)" },
]

function literalRemapOffsets(source: string): Array<string> {
  return [...source.matchAll(/\.remap\s*\([^,]+,\s*[-+]?\d+\s*\)/g)].map(([match]) => match)
}

async function currentLiteralRemapSites(): Promise<Array<LiteralRemapSite>> {
  const sites: Array<LiteralRemapSite> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    if (file.endsWith("/anthropic/keepalive-anchor.ts")) continue
    const relative = path.relative(repoRoot, file)
    for (const expression of literalRemapOffsets(await readFile(file, "utf8"))) sites.push({ file: relative, expression })
  }
  return sites.sort((a, b) => `${a.file}:${a.expression}`.localeCompare(`${b.file}:${b.expression}`))
}

function newLiteralRemapSites(current: ReadonlyArray<LiteralRemapSite>, baseline = LEGACY_LITERAL_REMAP_BASELINE): Array<LiteralRemapSite> {
  const allowed = new Map<string, number>()
  for (const site of baseline) {
    const key = `${site.file}:${site.expression}`
    allowed.set(key, (allowed.get(key) ?? 0) + 1)
  }
  return current.filter((site) => {
    const key = `${site.file}:${site.expression}`
    const remaining = allowed.get(key) ?? 0
    if (remaining === 0) return true
    allowed.set(key, remaining - 1)
    return false
  })
}

function anchorsOpenedRemapPredicates(source: string): Array<string> {
  return source.split("\n").filter((line) => /\b(?:if|while)\s*\(/.test(line) && /anchorsOpened\s*\(/.test(line) && /remap|offset|wireIndex/.test(line))
}

test("detectors bite on a new literal remap and an anchor-count remap predicate", () => {
  expect(literalRemapOffsets("hooks.remap(frame, 2)")).toEqual([".remap(frame, 2)"])
  expect(newLiteralRemapSites([{ file: "src/new-site.ts", expression: ".remap(frame, 2)" }])).toEqual([
    { file: "src/new-site.ts", expression: ".remap(frame, 2)" },
  ])
  expect(anchorsOpenedRemapPredicates("if (allocator.anchorsOpened() === 0) return frame // remap")).toHaveLength(1)
})

test("literal remap sites only shrink from the frozen P1 baseline", async () => {
  const current = await currentLiteralRemapSites()
  const additions = newLiteralRemapSites(current)
  expect(
    additions,
    `New literal remap site(s) bypass the single authority. Route them through resolveRemappedFrame instead. P3M must remove migrated entries from LEGACY_LITERAL_REMAP_BASELINE in the same commit; M4 must leave the baseline empty. New sites:\n${additions.map((site) => `${site.file}: ${site.expression}`).join("\n")}`,
  ).toEqual([])
  expect(current.length).toBeLessThanOrEqual(LEGACY_LITERAL_REMAP_BASELINE.length)
})

test("no source file gates a remap on anchorsOpened()", async () => {
  const violations: Array<string> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    const matches = anchorsOpenedRemapPredicates(await readFile(file, "utf8"))
    if (matches.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${matches.join(" | ")}`)
  }
  expect(violations).toEqual([])
})

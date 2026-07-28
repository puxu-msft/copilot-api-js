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

const LOW_LEVEL_ALLOCATION_NAMES = ["nextAnchorIndex", "nextRealIndex", "onAnchorOpen", "onRealBlockOpen", "allocateAnchor", "allocateRealBlock"]
function lowLevelAllocationCalls(source: string): Array<string> {
  return LOW_LEVEL_ALLOCATION_NAMES.flatMap((name) => [...source.matchAll(new RegExp(String.raw`\.${name}\s*\(`, "g"))].map(() => name))
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

test("detector bites when production code allocates outside the owner", () => {
  expect(lowLevelAllocationCalls("state.allocator.allocateAnchor()")).toEqual(["allocateAnchor"])
})

test("production allocation is owned only by keepalive allocator internals and delivery session", async () => {
  const violations: Array<string> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    if (file.endsWith("/anthropic/keepalive-anchor.ts") || file.endsWith("/pipeline/delivery/session.ts")) continue
    const matches = lowLevelAllocationCalls(await readFile(file, "utf8"))
    if (matches.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${matches.join(", ")}`)
  }
  expect(violations).toEqual([])
})

test("detectors bite on a second allocator creator and a second legacy provenance boundary", () => {
  expect('const second = createGenerationWireIndexAllocator()'.match(/createGenerationWireIndexAllocator\s*\(/g)).toHaveLength(1)
  expect('candidateId: "legacy", dispatchId: "legacy"'.match(/"legacy"/g)).toHaveLength(2)
})

test("the handler is the only production allocator creation point", async () => {
  const creators: Array<string> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    if (file.endsWith("/anthropic/keepalive-anchor.ts")) continue // factory definition, not a call site
    const count = (await readFile(file, "utf8")).match(/createGenerationWireIndexAllocator\s*\(/g)?.length ?? 0
    for (let i = 0; i < count; i++) creators.push(path.relative(repoRoot, file))
  }
  expect(creators).toEqual(["src/routes/messages/handler-v4.ts"])
})

test("legacy candidate provenance is confined to asDeliveryFrame", async () => {
  const occurrences: Array<string> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    const source = await readFile(file, "utf8")
    const count = source.match(/"legacy"/g)?.length ?? 0
    for (let i = 0; i < count; i++) occurrences.push(path.relative(repoRoot, file))
  }
  expect(occurrences).toEqual(["src/lib/pipeline/delivery/session.ts", "src/lib/pipeline/delivery/session.ts"])
  const session = await readFile(path.join(repoRoot, "src/lib/pipeline/delivery/session.ts"), "utf8")
  const helper = session.slice(session.indexOf("function asDeliveryFrame"), session.indexOf("async function writeToSink"))
  expect(helper.match(/"legacy"/g)).toHaveLength(2)
})

test("detector bites on owner-private mapping and open-anchor access", () => {
  expect("state.mappings.get(leg)".match(/\.mappings\.(?:get|set|delete)\s*\(/g)).toHaveLength(1)
  expect("state.openAnchorIndex = 1".match(/\bopenAnchorIndex\b/g)).toHaveLength(1)
})

test("mapping registry and open anchor state are accessed only by the delivery owner", async () => {
  const violations: Array<string> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    if (file.endsWith("/pipeline/delivery/session.ts") || file.endsWith("/pipeline/types.ts")) continue
    const source = await readFile(file, "utf8")
    if (/\.mappings\.(?:get|set|delete)\s*\(/.test(source) || /\bopenAnchorIndex\b/.test(source)) violations.push(path.relative(repoRoot, file))
  }
  expect(violations).toEqual([])
})

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
import ts from "typescript"

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

interface RemapCallSite {
  readonly file: string
  readonly call: string
}

/**
 * Explicit allowlist of every production remap call. Unlike the retired literal-offset regex, this
 * sees variable offsets and direct primitive calls and ignores comments. P3M removes the three
 * `legacy:*` entries as M2-M4 migrate their sites; M4 requires no `legacy:*` entry to remain.
 */
const REMAP_CALL_ALLOWLIST: ReadonlyArray<RemapCallSite> = [
  { file: "src/lib/anthropic/keepalive-anchor.ts", call: "internal:remapAnthropicBlockIndex" },
  { file: "src/lib/anthropic/keepalive-anchor.ts", call: "authority:mapping.remap" },
  { file: "src/lib/pipeline/delivery/session.ts", call: "owner:mapping.remap" },
  { file: "src/lib/pipeline/driver.ts", call: "legacy:anchor.remap" },
  { file: "src/lib/pipeline/driver.ts", call: "legacy:continuation.remap" },
  { file: "src/lib/pipeline/driver.ts", call: "legacy:anchor.remap" },
  { file: "src/lib/anthropic/live-reconcile.ts", call: "legacy:hooks.remap" },
]

function remapCalls(fileName: string, source: string): Array<RemapCallSite> {
  // These scanned production files are `.ts`; parsing them as TSX misreads generic arrow functions
  // (`<Value>`) as JSX and silently truncates the AST before later remap calls.
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: Array<RemapCallSite> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === "remapAnthropicBlockIndex") {
        calls.push({ file: fileName, call: "internal:remapAnthropicBlockIndex" })
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "remap") {
        const receiver = callee.expression.getText(sourceFile)
        const prefix =
          fileName.endsWith("/keepalive-anchor.ts") ? "authority"
          : fileName.endsWith("/delivery/session.ts") ? "owner"
          : "legacy"
        calls.push({ file: fileName, call: `${prefix}:${receiver}.remap` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

async function currentRemapCallSites(): Promise<Array<RemapCallSite>> {
  const sites: Array<RemapCallSite> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    const relative = path.relative(repoRoot, file)
    sites.push(...remapCalls(relative, await readFile(file, "utf8")))
  }
  return sites.sort((a, b) => `${a.file}:${a.call}`.localeCompare(`${b.file}:${b.call}`))
}

function unlistedRemapCalls(current: ReadonlyArray<RemapCallSite>, allowlist = REMAP_CALL_ALLOWLIST): Array<RemapCallSite> {
  const allowed = new Map<string, number>()
  for (const site of allowlist) {
    const key = `${site.file}:${site.call}`
    allowed.set(key, (allowed.get(key) ?? 0) + 1)
  }
  return current.filter((site) => {
    const key = `${site.file}:${site.call}`
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

test("allowlist detector bites on literal, variable-offset, and direct-primitive remap calls", () => {
  const file = "src/new-site.ts"
  for (const source of ["hooks.remap(frame, 2)", "hooks.remap(frame, offset)", "remapAnthropicBlockIndex(frame, 1)"]) {
    const calls = remapCalls(file, source)
    expect(calls).toHaveLength(1)
    expect(unlistedRemapCalls(calls)).toEqual(calls)
  }
  expect(remapCalls(file, "// hooks.remap(frame, 1)")).toEqual([])
  expect(anchorsOpenedRemapPredicates("if (allocator.anchorsOpened() === 0) return frame // remap")).toHaveLength(1)
})

test("all production remap calls are explicitly allowlisted", async () => {
  const current = await currentRemapCallSites()
  const additions = unlistedRemapCalls(current)
  expect(
    additions,
    `New remap call(s) bypass the single authority. Add only a justified authority/owner call; legacy sites must shrink through P3M and be empty after M4. New calls:\n${additions.map((site) => `${site.file}: ${site.call}`).join("\n")}`,
  ).toEqual([])
  expect(current).toEqual([...REMAP_CALL_ALLOWLIST].sort((a, b) => `${a.file}:${a.call}`.localeCompare(`${b.file}:${b.call}`)))
  // Builds a full TypeScript AST for every production source file, which costs ~3s on its own. Under
  // the 16-way sharding of `scripts/parallel-test.ts` that lands inside bun's 5s default and turns a
  // correct guard into a false red — and a gate that fails at random teaches people to ignore it. The
  // budget is raised rather than the scan narrowed: detection semantics stay exactly as they were.
}, 30_000)

test("migration bridge remap predicates are confined to the three not-yet-migrated legs", async () => {
  const violations: Array<string> = []
  for (const file of await sourceFiles(path.join(repoRoot, "src"))) {
    const matches = anchorsOpenedRemapPredicates(await readFile(file, "utf8"))
    if (matches.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${matches.join(" | ")}`)
  }
  expect(violations.every((entry) => entry.startsWith("src/lib/pipeline/driver.ts") || entry.startsWith("src/lib/anthropic/live-reconcile.ts"))).toBe(true)
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
  expect("const second = createGenerationWireIndexAllocator()".match(/createGenerationWireIndexAllocator\s*\(/g)).toHaveLength(1)
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

test("retired winner write APIs and candidate-shaped helper parameters cannot return", async () => {
  const session = await readFile(path.join(repoRoot, "src/lib/pipeline/delivery/session.ts"), "utf8")
  const driver = await readFile(path.join(repoRoot, "src/lib/pipeline/driver.ts"), "utf8")
  expect(session).not.toContain("commitWinnerBlock")
  expect(session).not.toContain("writeWinnerFrame")
  expect(driver).not.toContain("_candidate: CandidateHandle")
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

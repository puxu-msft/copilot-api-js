import {
  //
  expect,
  test,
} from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

const repoRoot = path.resolve(import.meta.dir, "../..")

interface CloseSite {
  readonly name: string
  readonly file: string
  readonly before: string
  readonly after: string
  readonly call: string
}

const CLOSE_SITES: ReadonlyArray<CloseSite> = [
  {
    name: "handler delayed-commit terminal",
    file: "src/routes/messages/handler-v4.ts",
    before: "const writeTerminalThenSettle",
    after: "let result: DriverRequestResult",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler direct stream-error",
    file: "src/routes/messages/handler-v4.ts",
    before: "const errorType = anthropicStreamErrorType(error)",
    after: "await sink\n        .writeSynthetic?.(",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler direct unrepairable tool",
    file: "src/routes/messages/handler-v4.ts",
    before: "} else if (env.ctx.unrepairableToolInput !== null)",
    after: "} else if (!acc.sawMessageStop)",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler direct truncation",
    file: "src/routes/messages/handler-v4.ts",
    before: "} else if (!acc.sawMessageStop)",
    after: "} else {",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler direct catch",
    file: "src/routes/messages/handler-v4.ts",
    before: "const failedCandidate = anthropicCandidateSnapshot(driver, upstream)",
    after: "// MARKER_DIAG_9z",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler translate stream-error",
    file: "src/routes/messages/handler-v4.ts",
    before: "const errUsage = meta?.usage",
    after: '// outcome.kind === "complete"',
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler translate truncation",
    file: "src/routes/messages/handler-v4.ts",
    before: 'const truncationError = new Error("upstream stream truncated: closed without finish_reason")',
    after: "// The processor finish boundary already emitted",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "handler translate catch",
    file: "src/routes/messages/handler-v4.ts",
    before: "const failedResponseData = (): ReturnType<typeof buildOpenAIResponseData>",
    after: "} finally {",
    call: "closeAnchorViaOwner(",
  },
  {
    name: "driver retreat terminal",
    file: "src/lib/pipeline/driver.ts",
    before: 'if (drained) return { kind: "complete"',
    after: "// COMMIT on a clean drain",
    call: 'closeAnchorViaOwner("terminal")',
  },
  {
    name: "driver exhausted terminal",
    file: "src/lib/pipeline/driver.ts",
    before: "// Exhausted / non-retryable",
    after: "// Block-level degrade",
    call: 'closeAnchorViaOwner("terminal")',
  },
  {
    name: "driver buffered close-before-real",
    file: "src/lib/pipeline/driver.ts",
    before: "const closeAnchorBeforeReal",
    after: "// Zero-content terminal",
    call: 'closeAnchorViaOwner("before-real")',
  },
  {
    name: "driver retreat write-through close-before-real",
    file: "src/lib/pipeline/driver.ts",
    before: "if (retreated) {",
    after: "// Capture the FIRST message_start",
    call: 'closeAnchorViaOwner("before-real")',
  },
  {
    name: "live decorator close",
    file: "src/lib/anthropic/live-reconcile.ts",
    before: "write: async",
    after: "for (const f of reconcileLiveFrame",
    call: "port.closeOpenAnchor(",
  },
]

function uniqueSlice(source: string, site: CloseSite): string {
  const starts: Array<number> = []
  let offset = 0
  while ((offset = source.indexOf(site.before, offset)) >= 0) {
    starts.push(offset)
    offset += site.before.length
  }
  const matching = starts
    .map((start) => ({ start, end: source.indexOf(site.after, start + site.before.length) }))
    .filter(({ end }) => end >= 0)
    .filter(({ start, end }) => source.slice(start, end).includes(site.call))
  expect(matching, `${site.name}: expected exactly one delimited region containing ${site.call}`).toHaveLength(1)
  return source.slice(matching[0].start, matching[0].end)
}

for (const site of CLOSE_SITES) {
  test(`M1 close site: ${site.name}`, async () => {
    const source = await readFile(path.join(repoRoot, site.file), "utf8")
    expect(uniqueSlice(source, site)).toContain(site.call)
  })
}

interface RetreatCloseCounts {
  readonly thenBeforeReal: number
  readonly conditionBeforeReal: number
  readonly elseBeforeReal: number
  readonly bufferedHelperBeforeReal: number
}

function countRetreatBeforeRealCloseSites(source: string): RetreatCloseCounts {
  const sourceFile = ts.createSourceFile("driver.ts", source, ts.ScriptTarget.Latest, true)
  const retreatBranches: Array<ts.IfStatement> = []
  let bufferedHelper: ts.VariableDeclaration | undefined
  const findSites = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node)
      && node.expression.getText(sourceFile) === "retreated"
      && node.thenStatement.getText(sourceFile).includes("const format = codecOperation")
    )
      retreatBranches.push(node)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "closeAnchorBeforeReal") bufferedHelper = node
    ts.forEachChild(node, findSites)
  }
  findSites(sourceFile)
  expect(retreatBranches, "driver must contain exactly one retreated branch").toHaveLength(1)
  if (retreatBranches.length !== 1) throw new Error("driver must contain exactly one retreated branch")
  expect(bufferedHelper, "driver must retain the buffered close helper").toBeDefined()
  if (bufferedHelper === undefined) throw new Error("driver must retain the buffered close helper")
  const retreat = retreatBranches[0]
  return {
    thenBeforeReal: countBeforeRealCalls(retreat.thenStatement),
    conditionBeforeReal: countBeforeRealCalls(retreat.expression),
    elseBeforeReal: countBeforeRealCalls(retreat.elseStatement),
    bufferedHelperBeforeReal: countBeforeRealCalls(bufferedHelper),
  }
}

function countBeforeRealCalls(node: ts.Node | undefined): number {
  if (node === undefined) return 0
  let count = 0
  const visit = (current: ts.Node): void => {
    if (isBeforeRealClose(current)) count++
    ts.forEachChild(current, visit)
  }
  visit(node)
  return count
}

function isBeforeRealClose(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "closeAnchorViaOwner"
    && node.arguments[0] !== undefined
    && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === "before-real"
  )
}

function expectRetreatCloseSite(source: string): void {
  const counts = countRetreatBeforeRealCloseSites(source)
  expect(counts.thenBeforeReal, "retreat then branch must contain exactly one before-real close").toBe(1)
  expect(counts.conditionBeforeReal, "retreat condition must not close the anchor").toBe(0)
  expect(counts.elseBeforeReal, "retreat else branch must not close the anchor").toBe(0)
  expect(counts.bufferedHelperBeforeReal, "buffered close helper remains a separate close site").toBe(1)
}

test("retreat close-site guard binds the before-real call exclusively to the retreat then branch", async () => {
  const source = await readFile(path.join(repoRoot, "src/lib/pipeline/driver.ts"), "utf8")
  expectRetreatCloseSite(source)
})

function retreatGuardFixture(thenBody: string, elseBody = ""): string {
  return `const closeAnchorBeforeReal = () => closeAnchorViaOwner("before-real")
if (retreated) {
  const format = codecOperation(() => ({ closesAnchor: true }))
  ${thenBody}
} else {
  ${elseBody}
}`
}

test("retreat close-site guard rejects in-memory branch mutations", () => {
  const close = 'await closeAnchorViaOwner("before-real")'
  const movedToElse = retreatGuardFixture("", close)
  const deleted = retreatGuardFixture("")
  const duplicated = retreatGuardFixture(`${close}\n  ${close}`)

  expectRetreatCloseSite(retreatGuardFixture(close))
  expect(() => expectRetreatCloseSite(movedToElse)).toThrow(/retreated branch|then branch|else branch/)
  expect(() => expectRetreatCloseSite(deleted)).toThrow(/then branch/)
  expect(() => expectRetreatCloseSite(duplicated)).toThrow(/then branch/)
})

test("M1 close-site registry remains the frozen 13-site population", () => {
  expect(CLOSE_SITES.map(({ name }) => name)).toHaveLength(13)
  expect(new Set(CLOSE_SITES.map(({ name }) => name)).size).toBe(13)
})

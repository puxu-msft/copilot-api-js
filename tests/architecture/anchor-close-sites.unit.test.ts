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

test("retreat close-site guard binds the actual before-real call inside the retreat branch", async () => {
  const source = await readFile(path.join(repoRoot, "src/lib/pipeline/driver.ts"), "utf8")
  const sourceFile = ts.createSourceFile("driver.ts", source, ts.ScriptTarget.Latest, true)
  let retreatCloseCalls = 0
  let bufferedHelperCloseCalls = 0

  const visit = (node: ts.Node, insideRetreat = false, insideBufferedHelper = false): void => {
    const nextInsideRetreat = insideRetreat || (ts.isIfStatement(node) && node.expression.getText(sourceFile) === "retreated")
    const nextInsideBufferedHelper =
      insideBufferedHelper || (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "closeAnchorBeforeReal")
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "closeAnchorViaOwner"
      && node.arguments[0] !== undefined
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "before-real"
    ) {
      if (nextInsideRetreat) retreatCloseCalls++
      if (nextInsideBufferedHelper) bufferedHelperCloseCalls++
    }
    ts.forEachChild(node, (child) => visit(child, nextInsideRetreat, nextInsideBufferedHelper))
  }
  visit(sourceFile)

  expect(retreatCloseCalls, "retreat write-through must close an open anchor before writing the real frame").toBe(1)
  expect(bufferedHelperCloseCalls, "buffered close helper remains a separate close site").toBe(1)
})

test("M1 close-site registry remains the frozen 13-site population", () => {
  expect(CLOSE_SITES.map(({ name }) => name)).toHaveLength(13)
  expect(new Set(CLOSE_SITES.map(({ name }) => name)).size).toBe(13)
})

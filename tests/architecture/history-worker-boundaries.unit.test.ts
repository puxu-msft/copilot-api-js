import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import { parseSource } from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")

interface AdmissionSite {
  readonly file: string
  readonly functionName: string
}

const PRODUCTION_OPERATION_SITES: ReadonlyArray<AdmissionSite> = [
  { file: "src/routes/chat-completions/handler-v4.ts", functionName: "handleChatCompletionV4" },
  { file: "src/routes/responses/handler-v4.ts", functionName: "handleResponsesV4" },
  { file: "src/routes/messages/handler-v4.ts", functionName: "handleMessagesV4" },
  { file: "src/routes/embeddings/route.ts", functionName: "handleEmbeddings" },
  { file: "src/routes/messages/count-tokens.ts", functionName: "handleCountTokens" },
  { file: "src/routes/gemini/handler-v4.ts", functionName: "runGeminiRequest" },
  { file: "src/routes/gemini/handler.ts", functionName: "handleCountTokens" },
  { file: "src/routes/responses/ws.ts", functionName: "handleResponseCreate" },
]

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  let match: ts.FunctionLikeDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
      && node.name
      && ts.isIdentifier(node.name)
      && node.name.text === name
    ) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!match) throw new Error(`Missing production operation function ${name} in ${sourceFile.fileName}`)
  return match
}

function historyAdmissionCalls(node: ts.Node): number {
  let calls = 0
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === "withHistoryAdmission") {
      calls++
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls
}

describe("History production admission boundaries", () => {
  test("AST criterion sees a live wrapper call but ignores comments and strings", () => {
    const live = parseSource("live.ts", "async function operation() { return withHistoryAdmission(c, 'generation', run) }")
    const inert = parseSource("inert.ts", "function operation() { const note = 'withHistoryAdmission(c)'; /* withHistoryAdmission(c) */ return note }")

    expect(historyAdmissionCalls(namedFunction(live, "operation"))).toBe(1)
    expect(historyAdmissionCalls(namedFunction(inert, "operation"))).toBe(0)
  })

  test("every production operation owner acquires exactly one History reservation", async () => {
    for (const site of PRODUCTION_OPERATION_SITES) {
      const absolute = path.join(repoRoot, site.file)
      const sourceFile = parseSource(absolute, await readFile(absolute, "utf8"))
      expect(historyAdmissionCalls(namedFunction(sourceFile, site.functionName)), `${site.file}:${site.functionName}`).toBe(1)
    }
  })

  test("Azure deployment routes reuse admitted handlers instead of acquiring a second reservation", async () => {
    const file = path.join(repoRoot, "src/routes/azure-openai/route.ts")
    const sourceFile = parseSource(file, await readFile(file, "utf8"))
    expect(historyAdmissionCalls(sourceFile)).toBe(0)
  })
})

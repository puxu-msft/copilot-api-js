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
const evaluatorPath = path.join(repoRoot, "src/routes/messages/precontent-recovery-evaluator.ts")
const handlerPath = path.join(repoRoot, "src/routes/messages/handler-v4.ts")

function functionNamed(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!found) throw new Error(`missing function ${name}`)
  return found
}

function propertyNames(object: ts.ObjectLiteralExpression): ReadonlyArray<string> {
  return object.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return []
    return [property.name.text]
  })
}

describe("pre-content recovery evaluator reachability", () => {
  test("evaluation mode invokes only the collector and keeps every non-complete outcome on the discard/fallback path", async () => {
    const evaluatorSource = await readFile(evaluatorPath, "utf8")
    const handlerSource = await readFile(handlerPath, "utf8")
    const evaluator = parseSource(evaluatorPath, evaluatorSource)
    const handler = parseSource(handlerPath, handlerSource)

    const evaluate = functionNamed(evaluator, "evaluateDirectRecovery")
    const calls: Array<ts.CallExpression> = []
    const visitEvaluator = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "runResponseSink") calls.push(node)
      ts.forEachChild(node, visitEvaluator)
    }
    visitEvaluator(evaluate)
    expect(calls).toHaveLength(1)
    const options = calls[0]?.arguments[3]
    expect(options && ts.isObjectLiteralExpression(options) ? propertyNames(options) : []).toEqual(["responseMode"])
    expect(options?.getText(evaluator)).toContain('responseMode: "evaluate"')

    const publish = functionNamed(handler, "evaluateAndPublishDirectAnthropicRecovery")
    const guards: Array<ts.IfStatement> = []
    const visitHandler = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) guards.push(node)
      ts.forEachChild(node, visitHandler)
    }
    visitHandler(publish)
    const nonComplete = guards.find((guard) => guard.expression.getText(handler) === 'evaluation.kind !== "complete"')
    expect(nonComplete?.thenStatement.getText(handler)).toContain("discardRecoveryEvaluation")
    expect(nonComplete?.thenStatement.getText(handler)).toContain('return { kind: "fallback" }')
  })

  test("unexpected evaluator outcomes are reachable only at the driver throw and snapshot-read boundaries", async () => {
    const source = await readFile(evaluatorPath, "utf8")
    const evaluator = parseSource(evaluatorPath, source)
    const evaluate = functionNamed(evaluator, "evaluateDirectRecovery")
    const boundaries: Array<ts.TryStatement> = []
    const visit = (node: ts.Node): void => {
      if (ts.isTryStatement(node) && node.catchClause?.block.getText(evaluator).includes('kind: "unexpected-throw"')) boundaries.push(node)
      ts.forEachChild(node, visit)
    }
    visit(evaluate)

    expect(boundaries).toHaveLength(2)
    expect(boundaries.map((boundary) => boundary.tryBlock.getText(evaluator))).toEqual(
      expect.arrayContaining([expect.stringContaining("runResponseSink"), expect.stringContaining("getCandidateSnapshot")]),
    )
    expect(boundaries.map((boundary) => boundary.catchClause?.block.getText(evaluator))).toEqual(
      expect.arrayContaining([expect.stringContaining("recoveryError"), expect.stringContaining("snapshotError")]),
    )
  })
})

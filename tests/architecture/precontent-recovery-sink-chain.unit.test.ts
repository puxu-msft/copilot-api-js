import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  readFile,
} from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import { parseSource } from "./source-ast"

const handlerPath = path.resolve(import.meta.dir, "../../src/routes/messages/handler-v4.ts")

function containingFunctionName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
  }
  return undefined
}

function callOwners(sourceFile: ts.SourceFile, callee: string): Array<string | undefined> {
  const owners: Array<string | undefined> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const direct = ts.isIdentifier(node.expression) && node.expression.text === callee
      const method = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === callee
      if (direct || method) owners.push(containingFunctionName(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return owners
}

describe("pre-content recovery sink-chain wiring", () => {
  test("both streaming owners hoist raw delivery, supervisor, reconcile, and final settlement outside pumps", async () => {
    const source = await readFile(handlerPath, "utf8")
    const sourceFile = parseSource(handlerPath, source)

    expect(callOwners(sourceFile, "createPreContentRecoverySinkChain")).toHaveLength(2)
    expect(callOwners(sourceFile, "liveReconcilingSink")).toHaveLength(1)
    expect(callOwners(sourceFile, "createRecoverySinkSupervisor")).toHaveLength(1)
    expect(callOwners(sourceFile, "getDownstreamDeliverySession")).toHaveLength(1)
    expect(callOwners(sourceFile, "settleFinal")).toHaveLength(3)
    expect(callOwners(sourceFile, "liveReconcilingSink")).not.toContain("pumpAnthropicStreamingV4")
    expect(callOwners(sourceFile, "liveReconcilingSink")).not.toContain("pumpTranslateLegStreamingV4")
  })
})

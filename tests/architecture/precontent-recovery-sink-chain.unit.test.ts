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

function functionLikeName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText()
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
      if (ts.isPropertyAssignment(parent)) return parent.name.getText()
      return "<anonymous>"
    }
  }
  return "<module>"
}

interface CallSite {
  readonly owner: string
  readonly arguments: ReadonlyArray<string>
}

function callSites(sourceFile: ts.SourceFile, callee: string): Array<CallSite> {
  const sites: Array<CallSite> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const direct = ts.isIdentifier(node.expression) && node.expression.text === callee
      const method = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === callee
      if (direct || method) {
        sites.push({
          owner: functionLikeName(node),
          arguments: node.arguments.map((argument) => argument.getText(sourceFile)),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

describe("pre-content recovery sink-chain wiring", () => {
  test("only the allowlisted chain factory owns supervisor, delivery lookup, and reconcile construction", async () => {
    const source = await readFile(handlerPath, "utf8")
    const sourceFile = parseSource(handlerPath, source)

    expect(callSites(sourceFile, "liveReconcilingSink").map((site) => site.owner)).toEqual(["createPreContentRecoverySinkChain"])
    expect(callSites(sourceFile, "createRecoverySinkSupervisor").map((site) => site.owner)).toEqual(["createPreContentRecoverySinkChain"])
    expect(callSites(sourceFile, "getDownstreamDeliverySession")).toEqual([{ owner: "createPreContentRecoverySinkChain", arguments: ["rawSink"] }])
    expect(callSites(sourceFile, "runResponseBufferedSink").map((site) => site.arguments[2])).toEqual(["rawSink"])
  })

  test("both stream owners create and finally settle one chain", async () => {
    const source = await readFile(handlerPath, "utf8")
    const sourceFile = parseSource(handlerPath, source)

    expect(callSites(sourceFile, "createPreContentRecoverySinkChain").map((site) => site.owner)).toEqual(["<anonymous>", "<anonymous>"])
    const settlementOwners = callSites(sourceFile, "settleFinal").map((site) => site.owner)
    expect(settlementOwners.filter((owner) => owner === "<anonymous>")).toHaveLength(2)
    expect(settlementOwners.filter((owner) => owner === "settleFinal")).toHaveLength(1)
  })
})

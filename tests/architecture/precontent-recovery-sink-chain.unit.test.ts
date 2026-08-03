import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  readFile,
  readdir,
} from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import { parseSource } from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const messagesRouteDirectory = path.join(repoRoot, "src/routes/messages")
const handlerPath = path.join(messagesRouteDirectory, "handler-v4.ts")
const chainPath = path.join(messagesRouteDirectory, "precontent-recovery-sink-chain.ts")
const liveReconcilePath = path.join(repoRoot, "src/lib/anthropic/live-reconcile.ts")
const compilerOptions = loadCompilerOptions()

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(repoRoot, "tsconfig.json")
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"))
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, repoRoot).options
}

function resolvedTarget(containingFile: string, specifier: string): string | undefined {
  return ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule?.resolvedFileName.replace(/\.js$/, ".ts")
}

function moduleImportsTarget(file: string, source: string, target: string): boolean {
  const sourceFile = parseSource(file, source)
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && resolvedTarget(file, statement.moduleSpecifier.text) === target,
  )
}

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
      if (direct || method) sites.push({ owner: functionLikeName(node), arguments: node.arguments.map((argument) => argument.getText(sourceFile)) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

describe("pre-content recovery sink-chain wiring", () => {
  test("only the dedicated chain module may import the rewriting capability", async () => {
    const routeFiles = (await readdir(messagesRouteDirectory)).filter((name) => name.endsWith(".ts")).map((name) => path.join(messagesRouteDirectory, name))
    const importers: Array<string> = []
    for (const file of routeFiles) {
      const source = await readFile(file, "utf8")
      if (moduleImportsTarget(file, source, liveReconcilePath)) importers.push(file)
    }

    expect(importers).toEqual([chainPath])
  })

  test("chain module owns supervisor, raw delivery lookup, and reconcile construction", async () => {
    const source = await readFile(chainPath, "utf8")
    const sourceFile = parseSource(chainPath, source)

    expect(callSites(sourceFile, "makeReconcilingSink").map((site) => site.owner)).toEqual(["liveReconcilingSink"])
    expect(callSites(sourceFile, "createRecoverySinkSupervisor").map((site) => site.owner)).toEqual(["createPreContentRecoverySinkChain"])
    expect(callSites(sourceFile, "getDownstreamDeliverySession")).toEqual([{ owner: "createPreContentRecoverySinkChain", arguments: ["rawSink"] }])
  })

  test("handler owners create/finally settle chains and retain one buffered path", async () => {
    const source = await readFile(handlerPath, "utf8")
    const sourceFile = parseSource(handlerPath, source)

    expect(callSites(sourceFile, "createPreContentRecoverySinkChain").map((site) => site.owner)).toEqual(["<anonymous>", "<anonymous>"])
    const settlementOwners = callSites(sourceFile, "settleFinal").map((site) => site.owner)
    expect(settlementOwners.filter((owner) => owner === "<anonymous>")).toHaveLength(2)
    expect(callSites(sourceFile, "runResponseBufferedSink")).toHaveLength(1)
  })
})

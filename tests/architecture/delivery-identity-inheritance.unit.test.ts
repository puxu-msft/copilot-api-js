import {
  //
  describe,
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

import { parseSource } from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const allowedCaller = path.join(repoRoot, "src/lib/pipeline/generation/recovery-sink-supervisor.ts")
const positiveControl = path.join(repoRoot, "tests/fixtures/architecture/illegal-delivery-identity-caller.ts")

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

function isDeliverySessionModule(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isStringLiteral(node) && (node.text.endsWith("/pipeline/delivery/session") || node.text === "../delivery/session")
}

/**
 * Guard the capability doors, not call spelling. To obtain the real exported function a module must import,
 * re-export, require, or dynamically import it. Aliases after that door do not matter; the door itself is
 * allowlisted. Namespace/star/dynamic forms are intentionally over-approximated because each exposes the
 * capability and none is needed outside the one owner.
 */
function referencesIdentityInheritanceCapability(file: string, source: string): boolean {
  const sourceFile = parseSource(file, source)
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isDeliverySessionModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) found = true
      if (
        bindings
        && ts.isNamedImports(bindings)
        && bindings.elements.some((element) => (element.propertyName ?? element.name).text === "inheritDownstreamDeliverySession")
      ) {
        found = true
      }
    }
    if (ts.isExportDeclaration(node) && isDeliverySessionModule(node.moduleSpecifier)) {
      const exports = node.exportClause
      if (
        exports === undefined
        || ts.isNamespaceExport(exports)
        || (ts.isNamedExports(exports)
          && exports.elements.some((element) => (element.propertyName ?? element.name).text === "inheritDownstreamDeliverySession"))
      ) {
        found = true
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isDeliverySessionModule(node.moduleReference.expression)) {
      found = true
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      if ((isDynamicImport || isRequire) && isDeliverySessionModule(node.arguments[0])) found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

describe("delivery identity inheritance architecture", () => {
  test("real scanner rejects a compiled non-allowlisted caller (positive control)", async () => {
    const source = await readFile(positiveControl, "utf8")
    expect(referencesIdentityInheritanceCapability(positiveControl, source)).toBe(true)
  })

  test("only recovery-sink-supervisor may access the identity-inheritance capability", async () => {
    const files = await sourceFiles(path.join(repoRoot, "src"))
    const callers: Array<string> = []
    for (const file of files) {
      if (referencesIdentityInheritanceCapability(file, await readFile(file, "utf8"))) callers.push(file)
    }

    expect(callers).toEqual([allowedCaller])
  })
})

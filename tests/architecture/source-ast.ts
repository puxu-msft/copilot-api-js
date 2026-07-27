/**
 * Shared TypeScript-AST helpers for the architecture guards.
 *
 * These guards answer questions about SOURCE STRUCTURE — "what does this module export", "what does
 * it import", "in what order are these calls made". Three review rounds established that answering
 * them with regexes and `indexOf` does not work: every fix covered the mutation its author had just
 * thought of, and the next probe found another LEGAL syntax that slipped through — comments between
 * tokens, a `}` inside a string, an alias, a star re-export, a commented-out call reading as live
 * wiring, and finally `import { op as x } from "./internal"; export { x }`, which no name-matching
 * scheme can trace at all.
 *
 * The parser is the only thing that covers the legal syntax SPACE rather than a growing list of
 * remembered forms. `ts.createSourceFile` is a pure syntactic parse — no program, no type checker,
 * no tsconfig resolution — so it costs a few milliseconds per file, and `typescript` is already a
 * dependency (the repo's own typecheck runs on it).
 */

import ts from "typescript"

/** Parse one source file syntactically (no program, no type checker). */
export function parseSource(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TSX)
}

/** Where an exported name ultimately comes from. */
export interface ExportOrigin {
  /** The name the barrel publishes it under. */
  exportedAs: string
  /** The name it is called in its defining module (differs whenever `as` is involved). */
  originalName: string
  /** The module it comes from — `null` when it is defined in this very file. */
  fromModule: string | null
}

/**
 * Every VALUE binding a module publishes, traced back to its origin module + original name.
 *
 * Handles, because each of these was a real bypass at some point:
 *  - `export { a } from "./m"` and `export { a as b } from "./m"`;
 *  - `import { a as x } from "./m"; export { x }` — the local-alias hop that defeats name matching;
 *  - comments anywhere between tokens, and `}`/`,` inside string literals.
 *
 * Type-only exports (`export type { … }`, and `type` specifiers inside a value block) are excluded:
 * they cannot carry a runtime operation.
 */
export function valueExportOrigins(sourceFile: ts.SourceFile): Array<ExportOrigin> {
  // local binding name → where it was imported from (only value imports).
  const importedBindings = new Map<string, { module: string; originalName: string }>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    if (statement.importClause.isTypeOnly) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const moduleName = statement.moduleSpecifier.text
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue
        importedBindings.set(element.name.text, { module: moduleName, originalName: (element.propertyName ?? element.name).text })
      }
    }
    if (statement.importClause.name) {
      importedBindings.set(statement.importClause.name.text, { module: moduleName, originalName: "default" })
    }
  }

  const origins: Array<ExportOrigin> = []
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const exportClause = statement.exportClause
    if (!exportClause || !ts.isNamedExports(exportClause)) continue // star exports: see valueStarReExports
    const moduleSpecifier =
      ts.isStringLiteral(statement.moduleSpecifier ?? ts.factory.createStringLiteral("")) ?
        (statement.moduleSpecifier as ts.StringLiteral | undefined)
      : undefined

    for (const element of exportClause.elements) {
      if (element.isTypeOnly) continue
      const localName = (element.propertyName ?? element.name).text
      if (moduleSpecifier) {
        origins.push({ exportedAs: element.name.text, originalName: localName, fromModule: moduleSpecifier.text })
        continue
      }
      // No module specifier: the name refers to a binding in THIS file — follow it back to its import.
      const imported = importedBindings.get(localName)
      origins.push({
        exportedAs: element.name.text,
        originalName: imported?.originalName ?? localName,
        fromModule: imported?.module ?? null,
      })
    }
  }
  return origins
}

/**
 * VALUE star re-exports (`export * from "./x"` / `export * as ns from "./x"`). One of these
 * republishes an entire module at once while any name-based check sees nothing — so it is a
 * structural question, not a naming one. `export type *` is excluded (type-only, carries no value).
 */
export function valueStarReExports(sourceFile: ts.SourceFile): Array<string> {
  const stars: Array<string> = []
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const clause = statement.exportClause
    const isStar = clause === undefined || ts.isNamespaceExport(clause)
    if (!isStar) continue
    const moduleSpecifier = statement.moduleSpecifier
    stars.push(ts.isStringLiteral(moduleSpecifier!) ? moduleSpecifier.text : statement.getText(sourceFile))
  }
  return stars
}

/**
 * Every module specifier a file actually imports at RUNTIME — static imports, side-effect imports,
 * re-export sources, `import()` and `require()`. Type-only imports are excluded (erased at build).
 * Being AST-based, a specifier that only appears inside a comment or a string is not counted.
 */
export function importedModuleSpecifiers(sourceFile: ts.SourceFile): Array<string> {
  const specifiers: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      const [firstArgument] = node.arguments
      if ((isDynamicImport || isRequire) && firstArgument && ts.isStringLiteral(firstArgument)) specifiers.push(firstArgument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

/**
 * EVERY module specifier a file references — value AND type-only, in any import/export form.
 *
 * This is the right question for a PACKAGE BOUNDARY (unlike the runtime-only variant used for
 * bundling concerns): a type-only import still couples the two modules, still shows up as a cycle
 * edge in the madge SCC snapshot, and was exactly the edge T4 had to sever to get telemetry out of
 * the core SCC. A boundary that ignored type imports would call a coupled package "clean".
 */
export function allModuleSpecifiers(sourceFile: ts.SourceFile): Array<string> {
  const specifiers: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    // `import x = require("y")` — the TS-only form.
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      const [firstArgument] = node.arguments
      if ((isDynamicImport || isRequire) && firstArgument && ts.isStringLiteral(firstArgument)) specifiers.push(firstArgument.text)
    }
    // `import type X from "y"` inside a type position (`import("y").T`).
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

/** Module specifiers imported TYPE-ONLY (`import type …`) — erased at build, so bundling-safe. */
export function typeOnlyModuleSpecifiers(sourceFile: ts.SourceFile): Array<string> {
  const specifiers: Array<string> = []
  for (const statement of sourceFile.statements) {
    const isTypeOnlyImport = ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true
    const isTypeOnlyExport = ts.isExportDeclaration(statement) && statement.isTypeOnly
    if (!isTypeOnlyImport && !isTypeOnlyExport) continue
    const moduleSpecifier = statement.moduleSpecifier
    if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) specifiers.push(moduleSpecifier.text)
  }
  return specifiers
}

/**
 * The source offset of the first real CALL matching `predicate`, or `null` when the call does not
 * exist. Only executable `CallExpression` nodes are considered, so a commented-out call reads as
 * ABSENT rather than present — the exact false green that let a deleted wiring pass a text guard.
 */
export function findCallOffset(sourceFile: ts.SourceFile, predicate: (call: ts.CallExpression) => boolean): number | null {
  let offset: number | null = null
  const visit = (node: ts.Node): void => {
    if (offset !== null) return
    if (ts.isCallExpression(node) && predicate(node)) {
      offset = node.getStart(sourceFile)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return offset
}

/** True when `call` is `<receiver>.<method>(…)` for the given method name. */
export function isMethodCall(call: ts.CallExpression, method: string): boolean {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === method
}

/** True when `call` is a bare `<fn>(…)` for the given function name. */
export function isFunctionCall(call: ts.CallExpression, fn: string): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === fn
}

/** The receiver identifier of a `<receiver>.<method>()` call, when the receiver is a plain identifier. */
export function methodCallReceiver(call: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null
  return ts.isIdentifier(call.expression.expression) ? call.expression.expression.text : null
}

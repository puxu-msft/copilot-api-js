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

/**
 * EVERY name a module makes publicly reachable, by ANY mechanism.
 *
 * The point is to enumerate the module's public SURFACE, not to trace where each name came from.
 * Provenance tracing is a losing game — three review rounds walked it down through aliases, local
 * re-export hops, `default`, namespace objects, `const` wrappers and cross-file chains, and each
 * depth only closed the bypass someone had just demonstrated. Enumerating the surface inverts the
 * burden: a caller compares this against an explicit allowlist, so ANY new export fails by default
 * regardless of the mechanism used to create it.
 *
 * Covers named exports (`export { a }`, `export { a as b }`, with or without a module specifier),
 * `export default …`, and exported declarations (`export const/function/class/enum …`). Type-only
 * specifiers are reported too — the public type surface is a contract as well. Star re-exports are
 * NOT enumerable from one file and are reported separately by {@link valueStarReExports}.
 */
export function publicExportNames(sourceFile: ts.SourceFile): Array<string> {
  const names: Array<string> = []

  /** Every name a binding introduces — `x`, `{ a, b: c }`, `[a, , b]`, and nested combinations. */
  const bindingNames = (name: ts.BindingName): Array<string> => {
    if (ts.isIdentifier(name)) return [name.text]
    return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))
  }

  for (const statement of sourceFile.statements) {
    // `export default <expression>`
    if (ts.isExportAssignment(statement)) {
      names.push("default")
      continue
    }

    // `export { … }` / `export type { … }` / `export { … } from "…"`
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.push(element.name.text)
      }
      continue
    }

    // `export const/let/var …`, `export function …`, `export class/enum/interface/type …`
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue

    // `export default function foo() {}` / `export default class {}` are published as `default`,
    // NOT under the declaration's own name — recording `foo` would let a declaration whose name
    // happens to be allowlisted publish anything at all through the default slot.
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.push("default")
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) names.push(...bindingNames(declaration.name))
      continue
    }
    const named = statement as { name?: ts.Node }
    if (named.name && ts.isIdentifier(named.name)) names.push(named.name.text)
  }
  return names
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
 * The source offset of the first real CALL matching `predicate` inside `scope`'s OWN execution flow,
 * or `null` when there is none.
 *
 * Two deliberate restrictions, each closing a demonstrated false green:
 *  - only executable `CallExpression` nodes count, so a commented-out or stringified call reads as
 *    ABSENT — which is what it is;
 *  - the walk does NOT descend into nested function/class bodies, so a call parked in a helper that
 *    is never invoked cannot stand in for real wiring (a `function decoy() { runJsonBackfill() }`
 *    passed the previous version while production was actually disconnected);
 *  - when `unconditionalOnly` is set, the walk also refuses to enter conditional constructs
 *    (`if`/loop/`switch`/`&&`/ternary), so a feature-gated or `if (false)` branch cannot stand in for
 *    wiring either. Plain blocks and `try`/`catch`/`finally` ARE entered: they do not gate whether
 *    the statement runs on the normal path, and production wraps these very calls in `try`.
 */
/** Constructs whose body may be skipped at runtime — a call inside one is not unconditional wiring. */
function isConditional(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node)
    || ts.isSwitchStatement(node)
    || ts.isConditionalExpression(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
  )
}

export function findCallInScope(scope: ts.Node, predicate: (call: ts.CallExpression) => boolean, unconditionalOnly = false): ts.CallExpression | null {
  let found: ts.CallExpression | null = null
  const visit = (node: ts.Node): void => {
    if (found !== null) return
    if (unconditionalOnly && isConditional(node)) return
    // Do not enter a nested callable — its body is a different execution flow.
    const isNestedCallable =
      node !== scope
      && (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node)
        || ts.isClassDeclaration(node)
        || ts.isClassExpression(node))
    if (isNestedCallable) return
    if (ts.isCallExpression(node) && predicate(node)) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(scope, visit)
  return found
}

/** The top-level function declaration named `name` (the startup path's own scope). */
export function findFunctionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
  }
  return null
}

/**
 * Whether a call is directly awaited (`await f()`), including `await (f())`. A milestone that must
 * COMPLETE before the next one starts has to be awaited — `initialize()` without `await` leaves the
 * server free to listen against a half-built window, while the source order still reads correctly.
 */
export function isAwaited(call: ts.CallExpression): boolean {
  let node: ts.Node | undefined = call.parent
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))) node = node.parent
  return node !== undefined && ts.isAwaitExpression(node)
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

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
 * Cheap pre-filter for the guards that AST-walk a whole tree: may `text` contain `needle` ONCE THE
 * PARSER HAS DECODED IT? Files that answer no can skip the parse.
 *
 * Three tiers, cheapest first, each sound on its own:
 *
 *  1. the raw text contains it — parse, nothing to decide;
 *  2. the raw text has no backslash — skip. Without escapes a string literal's value and an
 *     identifier's name are VERBATIM substrings of the source, so a decoded-only occurrence needs an
 *     escape, and every escape needs a backslash;
 *  3. otherwise LEX it. The scanner decodes literals and identifiers without building an AST, which
 *     is what makes this affordable.
 *
 * The tiers exist because the two cheaper criteria I tried first were both unsound and both looked
 * finished:
 *
 *  - `text.includes(needle)` alone, shipped with a comment claiming it could not miss.
 *    `"\x7e/routes/x"` IS `~/routes/x` to the parser while the raw text contains neither.
 *  - then `|| /\\[ux]/`, on the theory that producing an arbitrary character takes a hex or unicode
 *    escape. It does not: `"~/rout\es"` decodes to `~/routes` because `\e` is an identity escape,
 *    and a backslash-newline line continuation splices the needle across two lines. Both parse with
 *    zero diagnostics. The recurring lesson — a filter's soundness is a claim about the LANGUAGE,
 *    and enumerating the forms you happen to think of does not establish it. Only the lexer knows.
 *
 * Measured over `src/lib` (371 files): parse everything 585ms, tier-2 alone 126ms, these three
 * tiers 27ms. Cost matters because ~1.3s in isolation blows the default 5s timeout under 16-way
 * sharding, and a guard that times out intermittently is one people learn to ignore.
 *
 * Still invisible: text never spelled as a single token (`obj["SEPARATOR_" + "CARRIERS"]`). That is
 * a limit of the AST criterion the callers apply, not of this filter.
 */
export function mayContainDecoded(text: string, needle: string): boolean {
  if (text.includes(needle)) return true
  if (!text.includes("\\")) return false

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.JSX, text)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    // `getTokenValue()` is the DECODED text for the kinds that can carry an escape; for anything
    // else it is the raw token, which tier 1 already ruled out. Checking it unconditionally means a
    // token kind added to the language later cannot silently fall out of this filter.
    if (scanner.getTokenValue()?.includes(needle) === true) return true
  }
  return false
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
    if (ts.isCallExpression(node) && isModuleLoadCall(node)) {
      const [firstArgument] = node.arguments
      if (firstArgument && ts.isStringLiteralLike(firstArgument)) specifiers.push(firstArgument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

/**
 * Dynamic `import()` / `require()` calls whose module target CANNOT be determined statically —
 * `import(`${target}`)`, `import(path)`, `require(candidate)` — reported as their source text.
 *
 * This is the companion to `allModuleSpecifiers`, and the pair only makes sense together. That
 * function deliberately reports nothing for an opaque target, because inventing a specifier would be
 * a lie; but a guard that consumes only the specifier list then reads "no edge" where the honest
 * answer is "unknowable", and a claim like "this module imports only `node:` builtins" quietly
 * becomes "…plus whatever that expression resolves to at runtime".
 *
 * A guard asserting an ABSOLUTE property has to treat these as violations. A guard freezing a
 * specific edge set can instead register the known ones, so a NEW opaque call still surfaces.
 */
/**
 * What a NAME means where it is written: nothing, an ambient global, or a module loader.
 *
 * Resolution is lexical, and that is the whole point. The first version asked "does this file
 * declare `require` anywhere?", which is not a question about any particular call site — a
 * parameter named `require` inside one nested helper switched the ambient `require` off for the
 * entire file, and a genuine `require("~/routes/…")` two lines away then sailed through the core
 * ratchet with every test green. Scope was never optional; treating declarations as file-global was
 * simply the wrong model, in both directions (it also false-RED any file whose local helper happens
 * to be called `require`).
 *
 * `parseSource` sets parent pointers, so walking outward from the reference is enough; no type
 * checker, no program.
 */

/** The declaration of `name` visible AT `node`, or `undefined` when it resolves to an ambient global. */
function resolveDeclaration(node: ts.Node, name: string): ts.Node | undefined {
  for (let scope: ts.Node | undefined = node; scope !== undefined; scope = scope.parent) {
    const declared = declarationsIn(scope, name)
    if (declared) return declared
  }
  return undefined
}

/** Every name a binding pattern introduces, paired with the node that introduced it. */
function bindingDeclarations(name: ts.BindingName, declaration: ts.Node, into: Map<string, ts.Node>): void {
  if (ts.isIdentifier(name)) {
    into.set(name.text, declaration)
    return
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    bindingDeclarations(element.name, element, into)
  }
}

/** Names declared DIRECTLY by this scope node (not by its ancestors or nested scopes). */
function declarationsIn(scope: ts.Node, name: string): ts.Node | undefined {
  const declared = new Map<string, ts.Node>()

  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) bindingDeclarations(parameter.name, parameter, declared)
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    bindingDeclarations(scope.variableDeclaration.name, scope.variableDeclaration, declared)
  }

  const statements =
    ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements
    : ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements
    : undefined
  const lists = [
    ...(statements ?? []),
    ...((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer ? [scope.initializer] : []),
  ]

  for (const statement of lists) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingDeclarations(declaration.name, declaration, declared)
    }
    if (ts.isVariableDeclarationList(statement)) {
      for (const declaration of statement.declarations) bindingDeclarations(declaration.name, declaration, declared)
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declared.set(statement.name.text, statement)
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.name) declared.set(clause.name.text, clause)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) declared.set(bindings.name.text, bindings)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) declared.set(element.name.text, element)
      }
    }
  }
  return declared.get(name)
}

/** Is this expression the `node:module` module object — however it was obtained? */
function isNodeModuleObject(expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false
  const declaration = resolveDeclaration(expression, expression.text)
  if (declaration === undefined) return false

  // `import m from "node:module"` / `import * as m from "node:module"` / `import { default as m } …`
  if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) return importsNodeModule(declaration)
  if (ts.isImportSpecifier(declaration)) return (declaration.propertyName ?? declaration.name).text === "default" && importsNodeModule(declaration)
  // `const m = await import("node:module")` / `const m = require("node:module")`
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) return loadsNodeModule(declaration.initializer)
  return false
}

/** Does the import declaration owning this node name `node:module`? */
function importsNodeModule(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isImportDeclaration(current)) return ts.isStringLiteralLike(current.moduleSpecifier) && /^(?:node:)?module$/.test(current.moduleSpecifier.text)
  }
  return false
}

/** `await import("node:module")` / `import("node:module")` / `require("node:module")`. */
function loadsNodeModule(expression: ts.Expression): boolean {
  const inner = ts.isAwaitExpression(expression) ? expression.expression : expression
  if (!ts.isCallExpression(inner)) return false
  const isImport = inner.expression.kind === ts.SyntaxKind.ImportKeyword
  const isRequire = ts.isIdentifier(inner.expression) && inner.expression.text === "require"
  const [argument] = inner.arguments
  return (isImport || isRequire) && argument !== undefined && ts.isStringLiteralLike(argument) && /^(?:node:)?module$/.test(argument.text)
}

/** Does this expression denote `createRequire` — by any import, destructuring or namespace route? */
function isCreateRequireReference(expression: ts.Expression): boolean {
  // `m.createRequire`
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "createRequire" && isNodeModuleObject(expression.expression)
  if (!ts.isIdentifier(expression)) return false

  const declaration = resolveDeclaration(expression, expression.text)
  if (declaration === undefined) return false
  // `import { createRequire as x } from "node:module"`
  if (ts.isImportSpecifier(declaration)) return (declaration.propertyName ?? declaration.name).text === "createRequire" && importsNodeModule(declaration)
  // `const { createRequire } = await import("node:module")` / `= require("node:module")`
  if (ts.isBindingElement(declaration)) {
    const property = (declaration.propertyName ?? declaration.name) as ts.Node
    if (!ts.isIdentifier(property) || property.text !== "createRequire") return false
    const variable = declaration.parent.parent
    return ts.isVariableDeclaration(variable) && variable.initializer !== undefined && loadsNodeModule(variable.initializer)
  }
  return false
}

/** Does calling this expression load a module — `import(x)`, ambient `require(x)`, or a minted loader? */
function isModuleLoadCall(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true
  if (!ts.isIdentifier(node.expression)) return false

  const declaration = resolveDeclaration(node.expression, node.expression.text)
  // Undeclared here ⇒ the ambient Node global. Only `require` loads.
  if (declaration === undefined) return node.expression.text === "require"
  // Declared ⇒ it is a loader only if it came from `createRequire(...)`, whatever it is named. A
  // local helper that merely happens to be called `require` is not a module load.
  return ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && ts.isCallExpression(declaration.initializer) && isCreateRequireReference(declaration.initializer.expression)
}


/**
 * Dynamic `import()` / `require()` calls whose module target CANNOT be determined statically —
 * `import(`${target}`)`, `import(path)`, `require(candidate)` — reported as their source text.
 *
 * This is the companion to `allModuleSpecifiers`, and the pair only makes sense together. That
 * function deliberately reports nothing for an opaque target, because inventing a specifier would be
 * a lie; but a guard that consumes only the specifier list then reads "no edge" where the honest
 * answer is "unknowable", and a claim like "this module imports only `node:` builtins" quietly
 * becomes "…plus whatever that expression resolves to at runtime".
 *
 * A guard asserting an ABSOLUTE property has to treat these as violations. A guard freezing a
 * specific edge set can instead register the known ones, so a NEW opaque call still surfaces.
 */
export function opaqueModuleReferences(sourceFile: ts.SourceFile): Array<string> {
  const opaque: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isModuleLoadCall(node)) {
      const [firstArgument] = node.arguments
      if (firstArgument === undefined || !ts.isStringLiteralLike(firstArgument)) {
        opaque.push(node.getText(sourceFile).replace(/\s+/g, " "))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return opaque
}

/**
 * EVERY module specifier a file references — value AND type-only, in any import/export form.
 *
 * This is the right question for a PACKAGE BOUNDARY (unlike the runtime-only variant used for
 * bundling concerns): a type-only import still couples the two modules, still shows up as a cycle
 * edge in the madge SCC snapshot, and was exactly the edge T4 had to sever to get telemetry out of
 * the core SCC. A boundary that ignored type imports would call a coupled package "clean".
 *
 * **`isStringLiteralLike` at the CALL sites, `isStringLiteral` everywhere else**, and the asymmetry
 * is load-bearing rather than sloppy: a dynamic `import()` / `require()` takes an EXPRESSION, so
 * ``import(`consola`)`` compiles clean and slipped past every guard built on this — the state unit
 * looked free of bare packages and the core→server ratchet looked frozen. The declaration forms take
 * a grammar-level StringLiteral, so ``import m from `x` ``, ``export * from `x` ``,
 * ``import m = require(`x`)`` and ``import(`x`).T`` are all TS1141 "String literal expected"
 * (checked with tsc, not assumed). Widening those would advertise a form that cannot exist.
 *
 * Template literals WITH substitutions stay out on purpose: `` import(`~/${name}`) `` has no static
 * specifier to report, and inventing one would be a lie rather than a gap.
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
    if (ts.isCallExpression(node) && isModuleLoadCall(node)) {
      const [firstArgument] = node.arguments
      if (firstArgument && ts.isStringLiteralLike(firstArgument)) specifiers.push(firstArgument.text)
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
 *  - when `unconditionalOnly` is set, the walk refuses to enter constructs that may be skipped on the
 *    normal path — conditionals (`if`/loop/`switch`/`&&`/ternary), a `catch` clause (runs only when
 *    the `try` throws), a labeled statement (`break label` can jump over it) — rejects
 *    optional-chained calls (`runtime?.op()` is skipped when the receiver is nullish, which a
 *    must-run lifecycle call may never be), and stops walking a statement list after an
 *    unconditional `return`/`throw`/`break`/`continue`, since everything after it is unreachable.
 *    Plain blocks, the `try` block and `finally` ARE entered: a `try` body runs unconditionally
 *    (production wraps these very calls in one) and `finally` runs on both paths.
 *
 * **What this can and cannot prove.** It is a syntactic approximation of reachability, not control-
 * flow analysis: it proves the call is present, in this function's own flow, and not inside a
 * construct that visibly skips it. It CANNOT prove true reachability — a helper called just above
 * that always throws, a `process.exit()`, or any non-local flow still leaves the call unreached
 * while the walk sees it. The residual gap and the two candidate designs that would close it (a
 * narrow injectable sequencing helper with a runtime spy, or a booted-server e2e asserting recorded
 * phase order) are tracked in docs/todo/deferred-backlog.md.
 */
/** Statements after which the rest of the enclosing statement list is unreachable. */
function isTerminator(statement: ts.Statement): boolean {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)
}

/**
 * Constructs whose body may be SKIPPED on the normal path — a call inside one is not unconditional
 * wiring.
 *
 * `CatchClause` belongs here and its omission was a real false green: moving the production backfill
 * out of the `try` body and into `catch` left the normal startup path never running it, while the
 * guard stayed green. (`try` and `finally` do NOT belong: a `try` body runs unconditionally, and
 * `finally` runs on both the normal and the throwing path.)
 */
function isConditional(node: ts.Node): boolean {
  return (
    ts.isCatchClause(node)
    // `label: { break label; call() }` — a labeled block can be jumped out of.
    || ts.isLabeledStatement(node)
    || ts.isIfStatement(node)
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
    // Everything after an unconditional `return`/`throw`/`break`/`continue` in the SAME statement
    // list is unreachable, so stop reading that list there rather than counting what follows.
    if (unconditionalOnly && ts.isBlock(node)) {
      for (const statement of node.statements) {
        if (found !== null) return
        visit(statement)
        if (isTerminator(statement)) return
      }
      return
    }
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
      // `runtime?.op()` is skipped whenever the receiver is nullish — a lifecycle call that MUST run
      // may never be optional-chained, so this is not wiring regardless of the receiver's type.
      const isOptionalChained =
        node.questionDotToken !== undefined || (ts.isPropertyAccessExpression(node.expression) && node.expression.questionDotToken !== undefined)
      if (!unconditionalOnly || !isOptionalChained) {
        found = node
        return
      }
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

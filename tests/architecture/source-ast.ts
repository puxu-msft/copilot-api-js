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

import { realpathSync } from "node:fs"
import path from "node:path"
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
    if (scanner.getTokenValue()?.includes(needle)) return true
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
  const loaderNames = loaderBindingNames(sourceFile)
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && couldLoadModule(node, sourceFile, loaderNames)) {
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
 * Every construct in this file that COULD load a module, and its target when that is knowable.
 *
 * The callee test is deliberately an OVER-APPROXIMATION — `import(…)`, anything whose callee text
 * mentions `require`/`createRequire`, and `<x>.require(…)` — because the precise question ("does
 * this name resolve to a module loader?") requires a binder, and four rounds of review established
 * that hand-rolling one does not converge:
 *
 *  - matching the literal callee `require` missed `createRequire`-minted loaders entirely;
 *  - tracking `createRequire` bindings file-wide let a nested parameter named `require` switch the
 *    ambient loader off for the whole file;
 *  - resolving lexically by walking parent scopes still got `var` wrong, because `var` hoists to the
 *    function and my binder left it in the block — and `createRequire(import.meta.url)("consola")`
 *    slipped through anyway, since its callee is a call rather than an identifier.
 *
 * Each fix closed the demonstrated case and the next probe found another. The pattern is the same
 * one that has recurred throughout these guards: a criterion that must enumerate legal forms will
 * always be one form behind. So the criterion stops being "is this a loader" and becomes "could this
 * be one" — a question with no dependence on scope, hoisting, or callee shape.
 *
 * The cost is false positives: `require.resolve(x)`, a local helper that happens to be named
 * `require`, and the `createRequire(url)` call that only MINTS a loader are all reported. That is
 * the right direction to be wrong in. A guard asserting an absolute property rejects them outright
 * (the state unit has zero); a ratchet registers them once, with a note saying why each is benign.
 *
 * The ARGUMENT stays precise: a string-literal target is reported as an edge, anything else as
 * unknowable. Over-approximating there would invent module names that do not exist.
 */
export interface ModuleLoadSite {
  /** The call as written, for a registry row or an error message. */
  text: string
  /** The module it loads, when that is a literal; `undefined` when the target is computed. */
  specifier: string | undefined
}

export function moduleLoadSites(sourceFile: ts.SourceFile): Array<ModuleLoadSite> {
  const sites: Array<ModuleLoadSite> = []
  const loaderNames = loaderBindingNames(sourceFile)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && couldLoadModule(node, sourceFile, loaderNames)) {
      const [argument] = node.arguments
      sites.push({
        text: node.getText(sourceFile).replaceAll(/\s+/g, " "),
        specifier: argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

/** `require`/`createRequire` as a whole word — not `requireAuth`, not `myRequirements`. */
const LOADER_CALLEE = /(?:^|[^\p{ID_Continue}$])(?:require|createRequire)(?![\p{ID_Continue}$])/u

/**
 * Names bound to something that LOOKS like a loader factory — `const load = createRequire(url)` —
 * so that calling `load(…)` counts too.
 *
 * File-wide and scope-blind ON PURPOSE, and the distinction from the version this replaces is the
 * whole lesson: that one was also file-wide, but it under-approximated (one nested parameter named
 * `require` switched the ambient loader off everywhere), and an under-approximating guard is silently
 * blind. This one over-approximates — a same-named binding in an unrelated scope is also treated as
 * a loader — so being scope-blind can only ever produce an extra row to explain, never a miss.
 */
function loaderBindingNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && LOADER_CALLEE.test(node.initializer.getText(sourceFile))) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

function couldLoadModule(node: ts.CallExpression, sourceFile: ts.SourceFile, loaderNames: ReadonlySet<string>): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true
  // `(load)("x")` is the same call as `load("x")`; the parentheses are not a different construct.
  let callee: ts.Expression = node.expression
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression
  if (ts.isIdentifier(callee) && loaderNames.has(callee.text)) return true
  return LOADER_CALLEE.test(callee.getText(sourceFile))
}

/**
 * The string-literal first argument of EVERY call in the file, whatever the callee.
 *
 * Deliberately callee-blind. Naming the loader is what keeps failing — `(nodeRequire)("…")`, a
 * computed member access, a two-hop alias — and each dodge is about the CALLEE, never the target.
 * A caller looking for edges to a specific place can therefore ask this instead and stop caring how
 * the call is spelled.
 *
 * It over-reports by construction (any function taking a string that happens to look like a
 * specifier), which is why it is a building block rather than a guard: the caller filters by a
 * prefix that means something in its own domain.
 */
export function callArgumentLiterals(sourceFile: ts.SourceFile): Array<{ text: string; argument: string }> {
  const literals: Array<{ text: string; argument: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        literals.push({ text: node.getText(sourceFile).replaceAll(/\s+/g, " "), argument: argument.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return literals
}

/**
 * Sites where a file ACQUIRES the ability to load modules at runtime.
 *
 * This is what makes the load-site scan sound, and it exists because tracking loaders by name never
 * became sound no matter how it was written. The last attempt over-approximated the CALL but still
 * seeded from names whose initializer text mentioned `createRequire`, so a renamed import
 * (`import { createRequire as mint }`) or a factory alias (`const mint = createRequire`) walked
 * straight through — an under-approximation wearing an over-approximation's clothes. A reviewer had
 * to point that out; the shape looked right to me.
 *
 * Acquisition is a different kind of question. Aliasing is unbounded, but the CAPABILITY enters a
 * module through a small, syntactically visible set of doors: importing `node:module` (in any form
 * — that is the only place `createRequire` comes from) or calling `process.getBuiltinModule`. You
 * cannot alias what you never obtained, so guarding the doors needs no provenance analysis at all.
 *
 * Out of reach, and stated rather than implied: `eval`, `new Function`, and anything reached through
 * a value handed in from outside the module. Static analysis loses to those in general — these
 * guards catch drift, not an adversary with commit access.
 */
export function moduleCapabilityAcquisitions(sourceFile: ts.SourceFile): Array<string> {
  const acquisitions: Array<string> = []
  const isModuleSpecifier = (text: string): boolean => /^(?:node:)?module$/.test(text)

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && isModuleSpecifier(node.moduleSpecifier.text)) {
      acquisitions.push(node.getText(sourceFile).replaceAll(/\s+/g, " "))
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && isModuleSpecifier(node.moduleSpecifier.text)) {
      acquisitions.push(node.getText(sourceFile).replaceAll(/\s+/g, " "))
    }
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)
      && isModuleSpecifier(node.moduleReference.expression.text)
    ) {
      acquisitions.push(node.getText(sourceFile).replaceAll(/\s+/g, " "))
    }
    if (ts.isCallExpression(node)) {
      // The CALLEE has to be a loader too, otherwise `console.log("module")` counts as acquiring the
      // module-loading capability — which drowns the registry in noise and, worse, trains people to
      // add rows without reading them. Same for `getBuiltinModule`: it is `process`'s, and only when
      // asked for `module` itself.
      const [argument] = node.arguments
      const target = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined
      const calleeText = node.expression.getText(sourceFile)
      const isLoaderCallee = node.expression.kind === ts.SyntaxKind.ImportKeyword || LOADER_CALLEE.test(calleeText)
      const isProcessBuiltinGetter = /(?:^|[^\p{ID_Continue}$])process\.getBuiltinModule$/u.test(calleeText)
      if (target !== undefined && isModuleSpecifier(target) && (isLoaderCallee || isProcessBuiltinGetter)) {
        acquisitions.push(node.getText(sourceFile).replaceAll(/\s+/g, " "))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return acquisitions
}

/**
 * Files pulled in by a triple-slash `/// <reference path="…" />`.
 *
 * A dependency the module graph never mentions: no import statement, no specifier, yet the types it
 * brings in are usable and the coupling is real. This guard already counts type-only imports as
 * coupling, so leaving these out would make the claim stronger than the check — again.
 */
export function referencedFilePaths(sourceFile: ts.SourceFile): Array<string> {
  return sourceFile.referencedFiles.map((reference) => reference.fileName)
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
  const loaderNames = loaderBindingNames(sourceFile)
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    // `import x = require("y")` — the TS-only form.
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    }
    if (ts.isCallExpression(node) && couldLoadModule(node, sourceFile, loaderNames)) {
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

/**
 * Resolve a specifier with the PROJECT's compiler options, so a guard and `tsc` agree on what it
 * denotes. Built once per repo root; resolution itself is cheap.
 *
 * Guards that match specifier TEXT are testing a spelling, not a dependency: `~/routes/x` and
 * `../../routes/x` are the same module, and a guard that only knows the first reports the second as
 * no edge at all. That mistake was made and fixed in the state closure, and then left standing in
 * the core ratchet for four more rounds because nobody carried the lesson across.
 *
 * `convertCompilerOptionsFromJson`, not `parseJsonConfigFileContent`: the latter also expands the
 * `include` globs (~380ms) and these guards run in a sharded tier.
 */
export function createSpecifierResolver(repoRoot: string): (fromFile: string, specifier: string) => string | undefined {
  const configPath = path.join(repoRoot, "tsconfig.json")
  const raw = ts.readConfigFile(configPath, ts.sys.readFile)
  const converted = ts.convertCompilerOptionsFromJson((raw.config as { compilerOptions?: unknown }).compilerOptions, repoRoot, configPath)
  if (converted.errors.length > 0)
    throw new Error(
      `tsconfig.json compilerOptions failed to parse: ${converted.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`,
    )
  return (fromFile, specifier) => ts.resolveModuleName(specifier, fromFile, converted.options, ts.sys).resolvedModule?.resolvedFileName
}

/**
 * References to the ambient `require` binding — not just calls to it.
 *
 * For a unit whose claim is "static imports only", a MENTION is already the violation: `const a =
 * require` hands the loader to any name at all, `Reflect.apply(require, …, ["consola"])` never
 * writes a call with `require` as its callee, and both type-check. Chasing those through alias
 * chains is the losing game this file has already lost four times; refusing the identifier outright
 * is one line and admits no chain, because every chain must start by naming it.
 *
 * Only meaningful for a unit that genuinely never loads anything at runtime — the state closure has
 * zero mentions today. Anywhere else this would be far too blunt.
 *
 * `import.meta.require` counts as well, and excluding it was a real hole: the capability gate never
 * sees it either (nothing is imported), so `const r = import.meta.require` handed the loader to a
 * name with nothing left to notice. Other property accesses stay excluded — `foo.require` is
 * someone else's member, not a loader.
 */
export function ambientRequireReferences(sourceFile: ts.SourceFile): Array<string> {
  const references: Array<string> = []
  const record = (node: ts.Node): void => {
    references.push(node.getText(sourceFile).replaceAll(/\s+/g, " ").slice(0, 80))
  }
  const visit = (node: ts.Node): void => {
    // `import.meta.require` — a loader that exists without any import, like the ambient global.
    if (ts.isPropertyAccessExpression(node) && node.name.text === "require" && ts.isMetaProperty(node.expression)) {
      record(node)
    } else if (ts.isIdentifier(node) && node.text === "require") {
      const isMemberName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      const isDeclarationName =
        (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isBindingElement(node.parent)) && node.parent.name === node
      if (!isMemberName && !isDeclarationName) record(node.parent)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

/**
 * Is `target` inside `root`? Both canonicalised, and compared per path SEGMENT.
 *
 * Two mistakes folded into one helper because each was made twice. `startsWith(root)` also matches
 * a sibling `root-other/`, and `relative.startsWith("..")` also matches the legal filename
 * `..review.ts`. And without `realpath`, a symlink under `root` pointing outside it has an inside
 * SPELLING and an outside IDENTITY — which is how a `/// <reference>` walked out of `src/routes`
 * while the guard stayed green. The state closure got this right and the core ratchet was still
 * comparing lexical paths, because the fix lived in one consumer instead of here.
 */
export function containedIn(root: string, target: string): boolean {
  // A target that does not exist cannot be canonicalised; compare it lexically rather than throwing
  // ENOENT and taking the whole guard down instead of reporting the edge.
  const canonical = (candidate: string): string => {
    try {
      return realpathSync(candidate)
    } catch {
      return candidate
    }
  }
  const relative = path.relative(canonical(root), canonical(target))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

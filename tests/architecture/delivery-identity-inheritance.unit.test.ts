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
const deliverySession = path.join(repoRoot, "src/lib/pipeline/delivery/session.ts")
const compilerOptions = loadCompilerOptions()

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(repoRoot, "tsconfig.json")
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"))
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, repoRoot).options
}

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

type SourceMap = ReadonlyMap<string, string>

function normalizeResolvedFile(file: string): string {
  return path.resolve(file).replace(/\.js$/, ".ts")
}

function resolutionHost(sources: SourceMap): ts.ModuleResolutionHost {
  return {
    ...ts.sys,
    fileExists(file) {
      return sources.has(path.resolve(file)) || ts.sys.fileExists(file)
    },
    readFile(file) {
      return sources.get(path.resolve(file)) ?? ts.sys.readFile(file)
    },
  }
}

function resolveModule(containingFile: string, specifier: string, sources: SourceMap): string | undefined {
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, resolutionHost(sources)).resolvedModule?.resolvedFileName
  return resolved ? normalizeResolvedFile(resolved) : undefined
}

function moduleExportsIdentityCapability(file: string, sources: SourceMap, visited = new Set<string>()): boolean {
  const normalized = normalizeResolvedFile(file)
  if (normalized === deliverySession) return true
  if (visited.has(normalized)) return false
  visited.add(normalized)
  const source = sources.get(normalized) ?? ts.sys.readFile(normalized)
  if (source === undefined) return false
  const sourceFile = parseSource(normalized, source)
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = resolveModule(normalized, statement.moduleSpecifier.text, sources)
    if (!target) continue
    const exports = statement.exportClause
    const exposesCapability =
      exports === undefined
      || ts.isNamespaceExport(exports)
      || (ts.isNamedExports(exports) && exports.elements.some((element) => (element.propertyName ?? element.name).text === "inheritDownstreamDeliverySession"))
    if (exposesCapability && moduleExportsIdentityCapability(target, sources, visited)) return true
  }
  return false
}

/**
 * Guard capability doors, not module-specifier spelling. TypeScript's resolver canonicalizes aliases,
 * relative paths, extensions, and re-export targets to the real delivery/session.ts source before the
 * allowlist decides. The production scan intentionally covers src/ only; tests/ contains the positive-control
 * fixture and packages/ cannot import this core module under package-boundary rules.
 */
function referencesIdentityInheritanceCapability(file: string, source: string, sources: SourceMap = new Map([[path.resolve(file), source]])): boolean {
  const normalizedFile = path.resolve(file)
  const sourceFile = parseSource(normalizedFile, source)
  const resolvesCapability = (specifier: ts.Expression | undefined): boolean => {
    if (!specifier || !ts.isStringLiteral(specifier)) return false
    const target = resolveModule(normalizedFile, specifier.text, sources)
    return target !== undefined && moduleExportsIdentityCapability(target, sources)
  }
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && resolvesCapability(node.moduleSpecifier)) {
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
    if (ts.isExportDeclaration(node) && resolvesCapability(node.moduleSpecifier)) {
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
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && resolvesCapability(node.moduleReference.expression))
      found = true
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      if ((isDynamicImport || isRequire) && resolvesCapability(node.arguments[0])) found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const probeCases = (): Array<{ name: string; file: string; source: string; extraSources?: ReadonlyArray<readonly [string, string]> }> => {
  const deliveryDir = path.dirname(deliverySession)
  const nestedDir = path.join(deliveryDir, "decorators")
  const relayFile = path.join(deliveryDir, "relay.ts")
  return [
    {
      name: "named ~/",
      file: path.join(repoRoot, "src/probe.ts"),
      source: 'import { inheritDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"',
    },
    {
      name: "aliased ~/",
      file: path.join(repoRoot, "src/probe.ts"),
      source: 'import { inheritDownstreamDeliverySession as inheritIdentity } from "~/lib/pipeline/delivery/session"',
    },
    { name: "namespace ~/", file: path.join(repoRoot, "src/probe.ts"), source: 'import * as delivery from "~/lib/pipeline/delivery/session"' },
    { name: "named ./session", file: path.join(deliveryDir, "probe.ts"), source: 'import { inheritDownstreamDeliverySession } from "./session"' },
    { name: "namespace ./session", file: path.join(deliveryDir, "probe.ts"), source: 'import * as delivery from "./session"' },
    { name: "re-export ./session", file: path.join(deliveryDir, "probe.ts"), source: 'export { inheritDownstreamDeliverySession } from "./session"' },
    { name: "nested ../session", file: path.join(nestedDir, "probe.ts"), source: 'import { inheritDownstreamDeliverySession } from "../session"' },
    { name: "explicit .ts", file: path.join(deliveryDir, "probe.ts"), source: 'import { inheritDownstreamDeliverySession } from "./session.ts"' },
    { name: "explicit .js", file: path.join(deliveryDir, "probe.ts"), source: 'import { inheritDownstreamDeliverySession } from "./session.js"' },
    { name: "require", file: path.join(deliveryDir, "probe.ts"), source: 'const delivery = require("./session")' },
    { name: "dynamic import", file: path.join(deliveryDir, "probe.ts"), source: 'const delivery = await import("./session")' },
    {
      name: "re-export relay consumer",
      file: path.join(deliveryDir, "relay-consumer.ts"),
      source: 'import { inheritDownstreamDeliverySession } from "./relay"',
      extraSources: [[relayFile, 'export { inheritDownstreamDeliverySession } from "./session"']],
    },
  ]
}

describe("delivery identity inheritance architecture", () => {
  test("all module spelling probes resolve to the delivery/session capability", () => {
    for (const probe of probeCases()) {
      const sources = new Map<string, string>([[path.resolve(probe.file), probe.source], ...(probe.extraSources ?? [])])
      expect(referencesIdentityInheritanceCapability(probe.file, probe.source, sources), probe.name).toBe(true)
    }
  })

  test("real scanner rejects a compiled non-allowlisted caller (positive control)", async () => {
    const source = await readFile(positiveControl, "utf8")
    expect(referencesIdentityInheritanceCapability(positiveControl, source)).toBe(true)
  })

  test("only recovery-sink-supervisor may access the identity-inheritance capability", async () => {
    const files = await sourceFiles(path.join(repoRoot, "src"))
    const sources = new Map<string, string>(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)))
    const callers: Array<string> = []
    for (const [file, source] of sources) {
      if (referencesIdentityInheritanceCapability(file, source, sources)) callers.push(file)
    }
    expect(callers).toEqual([allowedCaller])
  })
})

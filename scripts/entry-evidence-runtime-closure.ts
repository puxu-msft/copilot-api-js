import {
  //
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import path from "node:path"

export interface RuntimeClosureFile {
  packageName: string
  packageRoot: string
  relativePath: string
  resolvedPath: string
}

export interface RuntimePackageIdentity {
  name: string
  version: string
  root: string
  packageJsonPath: string
}

export function bytewiseSort(values: Array<string>): Array<string> {
  return values.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
}

export function runtimeImportSpecifiers(source: string, loader: "ts" | "js"): Array<string> | undefined {
  try {
    return bytewiseSort([...new Set(new Bun.Transpiler({ loader }).scan(source).imports.map((imported) => imported.path))])
  } catch {
    return undefined
  }
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function packageIdentity(file: string): RuntimePackageIdentity | undefined {
  for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const packageJsonPath = path.join(directory, "package.json")
    try {
      if (!statSync(packageJsonPath).isFile()) continue
    } catch {
      continue
    }
    try {
      const metadata = Bun.JSONC.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>
      if (typeof metadata.name !== "string" || typeof metadata.version !== "string") return undefined
      return { name: metadata.name, version: metadata.version, root: realpathSync(directory), packageJsonPath: realpathSync(packageJsonPath) }
    } catch {
      return undefined
    }
  }
  return undefined
}

export function resolveRuntimeImport(specifier: string, importer: string): string | undefined {
  try {
    return realpathSync(Bun.resolveSync(specifier, importer))
  } catch {
    return undefined
  }
}

export async function discoverRuntimePackageClosure(entrySpecifier: string, importer: string): Promise<Array<RuntimeClosureFile> | undefined> {
  const entry = resolveRuntimeImport(entrySpecifier, importer)
  if (entry === undefined) return undefined
  let build: Awaited<ReturnType<typeof Bun.build>>
  try {
    build = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true })
  } catch {
    return undefined
  }
  if (!build.success || build.metafile === undefined) return undefined
  const files: Array<RuntimeClosureFile> = []
  for (const input of Object.keys(build.metafile.inputs)) {
    const resolvedPath = realpathSync(path.resolve(input))
    const identity = packageIdentity(resolvedPath)
    if (identity === undefined || !isInside(resolvedPath, identity.root)) return undefined
    const relativePath = path.relative(identity.root, resolvedPath).split(path.sep).join("/")
    if (relativePath === "" || relativePath.startsWith("../")) return undefined
    files.push({ packageName: identity.name, packageRoot: identity.root, relativePath, resolvedPath })
  }
  return files.sort((left, right) => {
    const packageOrder = Buffer.from(left.packageName).compare(Buffer.from(right.packageName))
    return packageOrder === 0 ? Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)) : packageOrder
  })
}

#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { bytewiseSort, discoverRuntimePackageClosure, packageIdentity } from "./entry-evidence-runtime-closure"

const ROOT = path.resolve(import.meta.dir, "..")
const outputArgument = process.argv.slice(2)
if (outputArgument.length !== 0 && (outputArgument.length !== 2 || outputArgument[0] !== "--out" || !path.isAbsolute(outputArgument[1]))) process.exit(2)
const OUTPUT = outputArgument.length === 0 ? path.join(ROOT, "scripts/entry-evidence-runtime-dependencies.json") : outputArgument[1]

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function lockIdentity(name: string, version: string, lock: Record<string, unknown>): string | undefined {
  const entry = lock[name]
  if (!Array.isArray(entry) || entry.length !== 4 || entry[0] !== `${name}@${version}` || typeof entry[3] !== "string") return undefined
  return entry[3]
}

const importer = path.join(ROOT, "scripts", "parallel-test-artifacts.ts")
const closure = await discoverRuntimePackageClosure("saxes", importer)
const packageJson = Bun.JSONC.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }
const lock = Bun.JSONC.parse(readFileSync(path.join(ROOT, "bun.lock"), "utf8")) as { packages?: Record<string, unknown> }
if (closure === undefined || lock.packages === undefined) throw new Error("unable to discover SAX runtime dependency closure")

const grouped = new Map<string, typeof closure>()
for (const file of closure) grouped.set(file.packageName, [...(grouped.get(file.packageName) ?? []), file])
if (JSON.stringify(bytewiseSort([...grouped.keys()])) !== JSON.stringify(["saxes", "xmlchars"])) throw new Error("unexpected SAX runtime package closure")

const packages = bytewiseSort([...grouped.keys()]).map((name) => {
  const files = grouped.get(name)!
  const identity = packageIdentity(files[0].resolvedPath)
  if (identity === undefined || identity.name !== name || files.some((file) => file.packageRoot !== identity.root))
    throw new Error(`inconsistent package identity: ${name}`)
  const integrity = lockIdentity(name, identity.version, lock.packages!)
  if (integrity === undefined) throw new Error(`package missing from lockfile: ${name}@${identity.version}`)
  return {
    name,
    version: identity.version,
    integrity,
    files: files.map((file) => ({ path: file.relativePath, sha256: sha256(file.resolvedPath) })),
  }
})
const saxes = packages.find((entry) => entry.name === "saxes")
if (saxes === undefined || packageJson.dependencies?.saxes !== saxes.version) throw new Error("package.json does not bind the resolved saxes version")

writeFileSync(OUTPUT, `${JSON.stringify({ schema_version: 1, packages }, null, 2)}\n`)

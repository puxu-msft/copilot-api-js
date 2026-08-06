#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const outputArgument = process.argv.slice(2)
if (outputArgument.length !== 0 && (outputArgument.length !== 2 || outputArgument[0] !== "--out" || !path.isAbsolute(outputArgument[1]))) process.exit(2)
const OUTPUT = outputArgument.length === 0 ? path.join(ROOT, "scripts/entry-evidence-runtime-dependencies.json") : outputArgument[1]
const PACKAGES = [
  {
    name: "saxes",
    version: "6.0.0",
    integrity: "sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==",
    files: ["saxes.js"],
  },
  {
    name: "xmlchars",
    version: "2.2.0",
    integrity: "sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==",
    files: ["xml/1.0/ed5.js", "xml/1.1/ed2.js", "xmlns/1.0/ed3.js"],
  },
] as const

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

const manifest = {
  schema_version: 1,
  packages: PACKAGES.map((packageEntry) => ({
    ...packageEntry,
    files: packageEntry.files.map((file) => ({ path: file, sha256: sha256(path.join(ROOT, "node_modules", packageEntry.name, file)) })),
  })),
}

writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`)

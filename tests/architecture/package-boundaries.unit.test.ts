import { describe, expect, test } from "bun:test"

import { readFile } from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")

describe("workspace packages", () => {
  test("root workspaces includes packages/*", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      workspaces?: Array<string>
    }
    expect(pkg.workspaces).toContain("packages/*")
  })

  test("foundation package.json declares correct name and is private", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, "packages/foundation/package.json"), "utf8"),
    ) as { name?: string; private?: boolean }
    expect(pkg.name).toBe("@hsupu/ghc-proxy-foundation")
    expect(pkg.private).toBe(true)
  })
})

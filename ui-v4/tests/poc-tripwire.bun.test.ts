import {
  //
  describe,
  expect,
  it,
} from "bun:test"
import {
  //
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import { join } from "node:path"

/**
 * Tripwire for the TanStack Table PoC (headless-component-stack ADR).
 *
 * `ModelsTableTanstack.poc.tsx` is a PoC with ZERO production references — it is
 * kept alive only by its own `.poc.vitest.test.tsx`. That is exactly the shape
 * knip false-negatives on ("test keeps a dead src component alive"). This guard
 * asserts the PoC stays UN-wired: if someone imports it from a real component,
 * this fails — forcing an explicit decision (either finish the ADR + formally
 * rewrite ModelsTable, deleting the PoC, or don't wire it). See the ADR's
 * implementation section: the PoC must be deleted in the same commit that lands
 * the real data-table rewrite.
 */
function walk(dir: string): Array<string> {
  const out: Array<string> = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p)
  }
  return out
}

describe("TanStack Table PoC tripwire", () => {
  it("PoC tables are not imported by any production source file", () => {
    const srcRoot = join(import.meta.dir, "..", "src")
    const offenders = walk(srcRoot).filter((f) => !f.endsWith(".poc.tsx") && /ModelsTableTanstack|ModelsTableAria/.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })
})

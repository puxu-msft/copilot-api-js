import {
  //
  readFileSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const BASELINE = path.join(REPO_ROOT, "tests/infra/entry-test-discovery-baseline.json")

// Discover with the SAME globs and the SAME ordering the guard uses, so the file
// this writes is the file that guard will accept — deriving it any other way just
// moves the mismatch somewhere I cannot see it.
const discovered = new Set<string>()
for (const suffix of ["unit", "it", "http"]) {
  for (const candidate of new Bun.Glob(`**/*.${suffix}.test.ts`).scanSync({ cwd: path.join(REPO_ROOT, "tests"), onlyFiles: true })) {
    discovered.add(`tests/${candidate}`)
  }
}
const files = [...discovered].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))

const raw = readFileSync(BASELINE, "utf8")
const parsed = JSON.parse(raw) as Record<string, unknown>
const before = parsed.files as Array<string>

const added = files.filter((f) => !before.includes(f))
const removed = before.filter((f) => !files.includes(f))

parsed.files = files
// The parser re-serialises and compares byte-for-byte, so canonical form is not cosmetic here.
writeFileSync(BASELINE, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")

console.log(`files: ${before.length} -> ${files.length}`)
console.log("added:", added)
console.log("removed:", removed)

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const CAPTURE = path.join(REPO_ROOT, "scripts/capture-entry-evidence.ts")

type SkipKind = "testcase" | "suite"

function git(tree: string, args: Array<string>): string {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function createFixture(options: { omitArtifacts?: boolean; skippedKind?: SkipKind; runtimeSkippedKind?: SkipKind; manifestDirectory?: boolean } = {}): {
  tree: string
  out: string
  entrySha: string
} {
  const tree = mkdtempSync(path.join(os.tmpdir(), "capture-entry-evidence-"))
  const out = mkdtempSync(path.join(os.tmpdir(), "capture-entry-evidence-out-"))
  rmSync(out, { recursive: true, force: true })
  mkdirSync(path.join(tree, "tests/infra"), { recursive: true })
  mkdirSync(path.join(tree, "scripts"), { recursive: true })
  mkdirSync(path.join(tree, "exp/inter-block-anchor-allocator"), { recursive: true })
  writeFileSync(path.join(tree, "tests/a.unit.test.ts"), "")
  writeFileSync(path.join(tree, "scripts/parallel-test.ts"), "export {}\n")
  git(tree, ["init"])
  git(tree, ["config", "user.email", "test@example.invalid"])
  git(tree, ["config", "user.name", "Test"])
  const runnerBlob = git(tree, ["hash-object", "scripts/parallel-test.ts"])
  const allowedSkipped =
    options.skippedKind === "testcase" ? [{ kind: "testcase", file: "tests/a.unit.test.ts", classname: "", name: "", ordinal: 1, count: 1, reason: "todo" }]
    : options.skippedKind === "suite" ? [{ kind: "suite", file: "tests/a.unit.test.ts", suite_name: "suite", count: 1, reason: "whole-suite-skip" }]
    : []
  writeFileSync(
    path.join(tree, "tests/infra/entry-test-discovery-baseline.json"),
    `${JSON.stringify({ schema_version: 1, runner_git_blob: runnerBlob, minimum_executed: 1, files: ["tests/a.unit.test.ts"], allowed_skipped: allowedSkipped }, null, 2)}\n`,
  )
  const runtimeSkippedKind = options.runtimeSkippedKind ?? options.skippedKind
  const testcase =
    runtimeSkippedKind === "testcase" ?
      '<testcase classname="" name="" file="tests/a.unit.test.ts"><skipped/></testcase>'
    : '<testcase classname="suite" name="case" file="tests/a.unit.test.ts"/>'
  const skippedIdentity =
    runtimeSkippedKind === "testcase" ? '[{ "kind": "testcase", "file": "tests/a.unit.test.ts", "classname": "", "name": "", "ordinal": 1, "count": 1 }]'
    : runtimeSkippedKind === "suite" ? '[{ "kind": "suite", "file": "tests/a.unit.test.ts", "suite_name": "suite", "count": 1 }]'
    : "[]"
  const artifacts =
    options.omitArtifacts ? "true" : (
      `printf '<testsuites>${testcase}</testsuites>\\n' > "$d/shard-01.xml"
printf '{\\n  "files": [\\n    "tests/a.unit.test.ts"\\n  ]\\n}\\n' > "$d/runtime-identity.json"
printf '{\\n  "executed": 1,\\n  "skipped": ${options.skippedKind ? 1 : 0},\\n  "skipped_identities": ${skippedIdentity}\\n}\\n' > "$d/skipped-multiset.json"`
    )
  const manifestCollision =
    options.manifestDirectory ? 'mkdir "$OUT/evidence-manifest.json"\nprintf "preserve me\\n" > "$OUT/evidence-manifest.json/sentinel.txt"' : ""
  writeFileSync(
    path.join(tree, "exp/inter-block-anchor-allocator/baseline-runs.sh"),
    `#!/usr/bin/env bash
set -eu
mkdir -p "$OUT"
for i in $(seq 1 "$RUNS"); do
  n=$(printf '%02d' "$i")
  d="$OUT/run-$n-artifacts"
  mkdir -p "$d"
  printf 'artifact_dir=%s\\n' "$d" > "$OUT/run-$n.log"
  ${artifacts}
done
${manifestCollision}
`,
  )
  git(tree, ["add", "."])
  git(tree, ["commit", "-m", "fixture"])
  return { tree, out, entrySha: git(tree, ["rev-parse", "HEAD"]) }
}

function runCapture(fixture: { tree: string; out: string; entrySha: string }): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      "bun",
      CAPTURE,
      "--tree",
      fixture.tree,
      "--entry-sha",
      fixture.entrySha,
      "--out",
      fixture.out,
      "--runs",
      "15",
      "--discovery-baseline",
      "tests/infra/entry-test-discovery-baseline.json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
}

function clean(fixture: { tree: string; out: string }): void {
  rmSync(fixture.tree, { recursive: true, force: true })
  rmSync(fixture.out, { recursive: true, force: true })
}

function expectPathFailure(fixture: { tree: string; out: string; entrySha: string }): void {
  const result = runCapture(fixture)
  expect(result.exitCode).toBe(2)
  expect(new TextDecoder().decode(result.stderr)).toContain("--out must be outside --tree")
  expect(existsSync(path.join(fixture.out, "evidence-manifest.json"))).toBe(false)
}

function replaceOut(fixture: { tree: string; out: string; entrySha: string }, out: string): void {
  fixture.out = out
}

describe("capture-entry-evidence", () => {
  test("rejects a lexical outside symlink parent whose missing child resolves inside TREE", () => {
    const fixture = createFixture()
    const lexicalOutside = mkdtempSync(path.join(os.tmpdir(), "capture-entry-evidence-link-"))
    try {
      const insideLink = path.join(lexicalOutside, "inside-tree")
      symlinkSync(fixture.tree, insideLink)
      replaceOut(fixture, path.join(insideLink, "new-child"))
      expectPathFailure(fixture)
      expect(existsSync(path.join(fixture.tree, "new-child"))).toBe(false)
    } finally {
      clean(fixture)
      rmSync(lexicalOutside, { recursive: true, force: true })
    }
  })

  test("rejects canonical --out paths inside TREE before creating evidence", () => {
    for (const mode of ["exact", "symlink", "symlink-child"] as const) {
      const fixture = createFixture()
      const lexicalOutside = mkdtempSync(path.join(os.tmpdir(), "capture-entry-evidence-link-"))
      try {
        const insideLink = path.join(lexicalOutside, "inside-tree")
        symlinkSync(fixture.tree, insideLink)
        replaceOut(
          fixture,
          mode === "exact" ? fixture.tree
          : mode === "symlink" ? insideLink
          : path.join(insideLink, "new-child"),
        )
        expectPathFailure(fixture)
      } finally {
        clean(fixture)
        rmSync(lexicalOutside, { recursive: true, force: true })
      }
    }
  })

  test("accepts a lexical outside symlink resolving outside TREE", () => {
    const fixture = createFixture()
    const lexicalOutside = mkdtempSync(path.join(os.tmpdir(), "capture-entry-evidence-link-"))
    const realOutside = mkdtempSync(path.join(os.tmpdir(), "capture-entry-evidence-real-"))
    try {
      const outLink = path.join(lexicalOutside, "outside-link")
      symlinkSync(realOutside, outLink)
      replaceOut(fixture, outLink)
      expect(runCapture(fixture).exitCode).toBe(0)
      expect(existsSync(path.join(realOutside, "evidence-manifest.json"))).toBe(true)
    } finally {
      clean(fixture)
      rmSync(lexicalOutside, { recursive: true, force: true })
      rmSync(realOutside, { recursive: true, force: true })
    }
  }, 30_000)

  test("writes complete manifest with deterministic aggregation artifacts", () => {
    const fixture = createFixture()
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(0)
      const manifest = JSON.parse(readFileSync(path.join(fixture.out, "evidence-manifest.json"), "utf8"))
      expect(manifest.runs).toHaveLength(15)
      expect(manifest.runs[0].junit_artifacts).toHaveLength(1)
      expect(manifest.runtime_identity_manifest).toMatchObject({
        path: path.join(fixture.out, "runtime-identity-manifest.json"),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(manifest.skipped_multiset).toMatchObject({
        path: path.join(fixture.out, "skipped-multiset-manifest.json"),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(JSON.parse(readFileSync(manifest.runtime_identity_manifest.path, "utf8")).runs).toHaveLength(15)
      expect(JSON.parse(readFileSync(manifest.skipped_multiset.path, "utf8")).runs).toHaveLength(15)
    } finally {
      clean(fixture)
    }
  }, 30_000)

  test("accepts testcase and suite skip union forms", () => {
    for (const skippedKind of ["testcase", "suite"] as const) {
      const fixture = createFixture({ skippedKind })
      try {
        expect(runCapture(fixture).exitCode).toBe(0)
      } finally {
        clean(fixture)
      }
    }
  }, 30_000)

  test("rejects a runnable testcase silently converted to the testcase skip union", () => {
    const fixture = createFixture({ runtimeSkippedKind: "testcase" })
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(5)
      expect(new TextDecoder().decode(result.stderr)).toContain("skipped identity multiset mismatch")
      expect(new TextDecoder().decode(result.stderr)).toContain("unexpected")
    } finally {
      clean(fixture)
    }
  }, 30_000)

  test("rejects a runnable testcase silently converted to the suite skip union", () => {
    const fixture = createFixture({ runtimeSkippedKind: "suite" })
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(5)
      expect(new TextDecoder().decode(result.stderr)).toContain("skipped identity multiset mismatch")
      expect(new TextDecoder().decode(result.stderr)).toContain("unexpected")
    } finally {
      clean(fixture)
    }
  }, 30_000)

  test("fails without a manifest when a successful run omits transfer artifacts", () => {
    const fixture = createFixture({ omitArtifacts: true })
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(5)
      expect(new TextDecoder().decode(result.stderr)).toContain("run artifact transfer is incomplete")
      expect(() => readFileSync(path.join(fixture.out, "evidence-manifest.json"), "utf8")).toThrow()
    } finally {
      clean(fixture)
    }
  }, 30_000)

  test("uses rc 6 without replacing or deleting a pre-existing manifest target", () => {
    const fixture = createFixture({ manifestDirectory: true })
    const target = path.join(fixture.out, "evidence-manifest.json")
    const sentinel = path.join(target, "sentinel.txt")
    const temporary = path.join(fixture.out, ".evidence-manifest.json.tmp")
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(6)
      expect(new TextDecoder().decode(result.stderr)).toContain("manifest write failed")
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n")
      expect(existsSync(target)).toBe(true)
      expect(existsSync(temporary)).toBe(false)
    } finally {
      clean(fixture)
    }
  }, 30_000)
})

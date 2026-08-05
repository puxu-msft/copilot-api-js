import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const CAPTURE = path.join(REPO_ROOT, "scripts/capture-entry-evidence.ts")

function git(tree: string, args: Array<string>): string {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function createFixture(omitArtifacts = false): { tree: string; out: string; entrySha: string } {
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
  writeFileSync(
    path.join(tree, "tests/infra/entry-test-discovery-baseline.json"),
    `${JSON.stringify({ schema_version: 1, runner_git_blob: runnerBlob, minimum_executed: 1, files: ["tests/a.unit.test.ts"], allowed_skipped: [] }, null, 2)}\n`,
  )
  const artifacts = omitArtifacts
    ? "true"
    : `printf '<testsuites><testcase classname="suite" name="case" file="tests/a.unit.test.ts"/></testsuites>\\n' > "$d/shard-01.xml"
printf '{\\n  "files": [\\n    "tests/a.unit.test.ts"\\n  ]\\n}\\n' > "$d/runtime-identity.json"
printf '{\\n  "executed": 1,\\n  "skipped": 0,\\n  "skipped_identities": []\\n}\\n' > "$d/skipped-multiset.json"`
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

describe("capture-entry-evidence", () => {
  test("writes an atomic evidence manifest from declared per-run artifacts", () => {
    const fixture = createFixture()
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(0)
      const manifest = JSON.parse(readFileSync(path.join(fixture.out, "evidence-manifest.json"), "utf8"))
      expect(manifest.runs).toHaveLength(15)
      expect(manifest.runs[0].junit_artifacts).toHaveLength(1)
    } finally {
      rmSync(fixture.tree, { recursive: true, force: true })
      rmSync(fixture.out, { recursive: true, force: true })
    }
  }, 30_000)

  test("fails without a manifest when a successful run omits transfer artifacts", () => {
    const fixture = createFixture(true)
    try {
      const result = runCapture(fixture)
      expect(result.exitCode).toBe(5)
      expect(new TextDecoder().decode(result.stderr)).toContain("run artifact transfer is incomplete")
      expect(() => readFileSync(path.join(fixture.out, "evidence-manifest.json"), "utf8")).toThrow()
    } finally {
      rmSync(fixture.tree, { recursive: true, force: true })
      rmSync(fixture.out, { recursive: true, force: true })
    }
  }, 30_000)
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  cpSync,
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
const BASELINE_RUNS = path.join(REPO_ROOT, "exp/inter-block-anchor-allocator/baseline-runs.sh")

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
  function runBaselineSummaryFixture(
    runnerExitCode: number,
    summary?: string,
    options: { minTests?: string } = {},
  ): { result: ReturnType<typeof Bun.spawnSync>; log: string } {
    const tree = mkdtempSync(path.join(os.tmpdir(), "baseline-summary-"))
    const out = path.join(tree, "out")
    const scriptDir = path.join(tree, "exp/inter-block-anchor-allocator")
    const fakeRunner = path.join(tree, "fake-runner.sh")
    mkdirSync(scriptDir, { recursive: true })
    cpSync(BASELINE_RUNS, path.join(scriptDir, "baseline-runs.sh"))
    const failed = runnerExitCode === 0 ? 0 : 1
    const passed = 10 - failed
    const summaryLine = summary ?? `[parallel-test] 2 shards · 10 tests · ${passed} pass · ${failed} fail · 10 executed · 0 skipped · 1s`
    writeFileSync(
      fakeRunner,
      `#!/usr/bin/env bash
printf '%s\\n' '${summaryLine}'
printf '[parallel-test] artifacts=/tmp/fake-artifacts\\n'
exit ${runnerExitCode}
`,
    )
    git(tree, ["init"])
    git(tree, ["config", "user.email", "test@example.invalid"])
    git(tree, ["config", "user.name", "Test"])
    git(tree, ["add", "."])
    git(tree, ["commit", "-m", "fixture"])
    // This suite itself runs under the evidence producer, which exports
    // REQUIRE_TEST_ARTIFACTS=1 and PARALLEL_TEST_ARTIFACT_DIR. Inheriting those sends the wrapper
    // down the artifact-transfer branch and fails a run that has nothing to do with summary
    // accounting -- observed as two reds in a backend run invoked the way T0.0f invokes it.
    const environment = { ...process.env }
    delete environment.PARALLEL_TEST_ARTIFACT_DIR
    try {
      const result = Bun.spawnSync(["bash", path.join(scriptDir, "baseline-runs.sh"), "bash", fakeRunner], {
        cwd: tree,
        env: {
          ...environment,
          OUT: out,
          RUNS: "1",
          MIN_RUNS: "1",
          MIN_TESTS: options.minTests ?? "10",
          REQUIRE_TEST_ARTIFACTS: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      return { result, log: readFileSync(path.join(out, "run-01.log"), "utf8") }
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }

  test("baseline runner reads the count summary rather than a later artifacts line", () => {
    const { result, log } = runBaselineSummaryFixture(0)
    expect(result.exitCode).toBe(0)
    expect(log).toContain("=== tests seen   : 10")
  })

  // The validator compares each run log's canonical_command field against the manifest's, so a log
  // that only carries the human `=== command` line fails C9 and no receipt is ever written. That is
  // exactly what the first real batch hit. Space-joined, not %q-quoted: %q leaves a trailing space.
  test("baseline runner records the canonical command as a machine-readable field", () => {
    const { log } = runBaselineSummaryFixture(0)
    const field = /^canonical_command=(.+)$/m.exec(log)?.[1]
    expect(field).toBeDefined()
    expect(field).toMatch(/^bash \/.*\/fake-runner\.sh$/)
    expect(field?.endsWith(" ")).toBe(false)
  })

  test("baseline runner preserves a failing suite's count and exit-code diagnosis", () => {
    const { result, log } = runBaselineSummaryFixture(7)
    const stderr = new TextDecoder().decode(result.stderr)
    expect(result.exitCode).toBe(1)
    expect(log).toContain("=== tests seen   : 10")
    expect(stderr).toContain("run 01 exited 7")
    expect(stderr).not.toContain("reported no tests")
  })

  test("baseline runner accepts the producer's optional crash summary suffix", () => {
    const { result, log } = runBaselineSummaryFixture(
      0,
      "[parallel-test] 2 shards · 10 tests · 10 pass · 0 fail · 10 executed · 0 skipped · 1 shard(s) crashed (see isolated re-run above) · 1.25s",
    )
    expect(result.exitCode).toBe(0)
    expect(log).toContain("=== tests seen   : 10")
  })

  test.each([
    "[parallel-test] 2 shards · 10 tests · 10 pass · 0 fail · 10 executed · 0 skipped · 1s artifacts=/tmp/forged",
    "[parallel-test] 2 shards · 10 tests · 10 pass · 0 fail · 10 executed · 0 skipped",
  ])("baseline runner rejects count-shaped non-summary lines: %s", (summary) => {
    const { result, log } = runBaselineSummaryFixture(0, summary)
    expect(result.exitCode).toBe(1)
    expect(log).toContain("=== no summary  : the log has no [parallel-test] summary line")
    expect(new TextDecoder().decode(result.stderr)).toContain("produced no recognizable [parallel-test] summary line")
  })

  // "No summary at all" must not be routed through the MIN_TESTS floor: that
  // comparison is `0 -lt MIN_TESTS`, which is false when the caller's floor is 0,
  // and the discovery-baseline schema accepts a 0 floor. Without its own gate this
  // run would be graded green while the wrapper understood nothing about it.
  test("baseline runner fails an unrecognizable summary even when MIN_TESTS is 0", () => {
    const { result, log } = runBaselineSummaryFixture(0, "[parallel-test] something entirely different", { minTests: "0" })
    expect(result.exitCode).toBe(1)
    expect(log).toContain("=== no summary  : the log has no [parallel-test] summary line")
    expect(new TextDecoder().decode(result.stderr)).toContain("produced no recognizable [parallel-test] summary line")
  })

  // The floor and the summary gate are different questions; a run whose summary
  // parses fine but reports too few tests must still be graded by the floor.
  test("baseline runner keeps reporting a real count against the floor", () => {
    const { result, log } = runBaselineSummaryFixture(0, undefined, { minTests: "11" })
    expect(result.exitCode).toBe(1)
    expect(log).toContain("=== tests seen   : 10")
    expect(new TextDecoder().decode(result.stderr)).toContain("MIN_TESTS=11")
  })

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

describe("baseline-runs summary accounting", () => {
  // Exercises the shipped wrapper bytes, but from a throwaway git repo: the wrapper
  // derives REPO from its own location and fails any run whose tree or HEAD moves,
  // so pointing it at the shared worktree would go red whenever a peer commits.
  // The copy is asserted byte-identical, so this still grades the real script.
  const WRAPPER = "exp/inter-block-anchor-allocator/baseline-runs.sh"

  function runWrapper(options: { tests: number; executed: number; minTests: number }): { exitCode: number; seen: string; stderr: string } {
    const work = mkdtempSync(path.join(os.tmpdir(), "baseline-runs-summary-"))
    try {
      const wrapper = path.join(work, WRAPPER)
      mkdirSync(path.dirname(wrapper), { recursive: true })
      const shipped = readFileSync(path.join(REPO_ROOT, WRAPPER))
      writeFileSync(wrapper, shipped, { mode: 0o755 })
      expect(Bun.SHA256.hash(readFileSync(wrapper), "hex")).toBe(Bun.SHA256.hash(shipped, "hex"))
      git(work, ["init"])
      git(work, ["config", "user.email", "test@example.invalid"])
      git(work, ["config", "user.name", "Test"])
      git(work, ["add", "."])
      git(work, ["commit", "-m", "wrapper"])

      const runner = path.join(work, "fake-runner.sh")
      writeFileSync(
        runner,
        `#!/usr/bin/env bash\nprintf '[parallel-test] 16 shards · ${options.tests} tests · ${options.tests} pass · 0 fail · ${options.executed} executed · 30 skipped · 1.00s\\n'\nprintf '[parallel-test] artifacts=%s\\n' "\${PARALLEL_TEST_ARTIFACT_DIR:-/tmp/none}"\n`,
        { mode: 0o755 },
      )
      const out = path.join(work, "runs")
      // Every wrapper knob is pinned, including the ones this case does not vary:
      // the suite itself runs under the evidence producer, which exports
      // REQUIRE_TEST_ARTIFACTS=1 and PARALLEL_TEST_ARTIFACT_DIR. Inheriting those
      // sends the wrapper down the artifact-transfer branch and fails a run that
      // has nothing to do with summary accounting.
      const environment = { ...process.env }
      delete environment.PARALLEL_TEST_ARTIFACT_DIR
      const result = Bun.spawnSync([wrapper, "bash", runner], {
        env: {
          ...environment,
          OUT: out,
          RUNS: "1",
          MIN_RUNS: "1",
          MIN_TESTS: String(options.minTests),
          ALLOW_DIRTY: "1",
          STOP_ON_FAIL: "1",
          REQUIRE_TEST_ARTIFACTS: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = new TextDecoder().decode(result.stderr)
      const log = path.join(out, "run-01.log")
      // A wrapper that bailed before running (rc 2/3) leaves no log; surfacing its
      // stderr keeps that failure diagnosable instead of an ENOENT from the reader.
      // `(\S.*)` not `(.+)`: with `.+` the separator's `\s*` and the capture can both claim the same run of spaces — the ambiguity `regexp/no-super-linear-backtracking` flags. Trailing space is still handled by `.trim()`.
      const seen = existsSync(log) ? (/^=== tests seen\s*:\s*(\S.*)$/m.exec(readFileSync(log, "utf8"))?.[1]?.trim() ?? "") : ""

      return { exitCode: result.exitCode, seen, stderr }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  test("reads the executed population past the trailing artifact-dir line", () => {
    const result = runWrapper({ tests: 6719, executed: 7259, minTests: 7255 })

    expect({ exitCode: result.exitCode, seen: result.seen, stderr: result.stderr }).toEqual({ exitCode: 0, seen: "7259", stderr: "" })
  })

  test("still rejects a degenerate run that reports almost nothing", () => {
    const result = runWrapper({ tests: 1, executed: 1, minTests: 7255 })

    expect(result.exitCode).not.toBe(0)
    expect(result.seen).toBe("1")
    expect(result.stderr).toContain("MIN_TESTS=7255")
  })
})

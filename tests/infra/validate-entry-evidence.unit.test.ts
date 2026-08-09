import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { type EntryEvidenceReceiptV1Expected, validateEntryEvidenceReceiptV1 } from "../../scripts/entry-evidence-receipt"
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Nearly every case here builds a temp git tree, commits into it once per control, and re-runs the
// validator — work that lands on top of bun's 5000ms default rather than comfortably inside it.
// Running this file on its own, with nothing else from the suite competing, cases came in at 5055ms,
// 5071ms, 5151ms and 6036ms, and one reached 8927ms; under `test:fast` sharding they tip over
// regularly. Scope those numbers honestly: the host carried heavy unrelated background load at the
// time (load average around 40), so they say the default is too tight under realistic conditions,
// not that the work is inherently 5s+. That is the condition worth designing for — CI hosts and
// developer machines are rarely idle.
// The timeout is set per file rather than per case because the pressure is a property of the fixture
// strategy, not of any one case — fixing only the case you happened to watch fail leaves the rest.
// A guard that reddens with machine load, in a file unrelated to whatever the reader was changing,
// gets deleted rather than diagnosed.
setDefaultTimeout(120_000)

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const HANDOVER = "docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md"
const BASELINE = "tests/infra/entry-test-discovery-baseline.json"
const DEPENDENCY_INTEGRITY_MANIFEST = "scripts/entry-evidence-runtime-dependencies.json"
const SAX_RUNTIME_FILES = ["saxes/saxes.js", "xmlchars/xml/1.0/ed5.js", "xmlchars/xml/1.1/ed2.js", "xmlchars/xmlns/1.0/ed3.js"]

function resolvedPackageRoot(name: string): string {
  let directory = path.dirname(Bun.resolveSync(name, path.join(REPO_ROOT, "scripts/parallel-test-artifacts.ts")))
  while (directory !== path.dirname(directory)) {
    if (existsSync(path.join(directory, "package.json"))) return directory
    directory = path.dirname(directory)
  }
  throw new Error(`package root not found: ${name}`)
}

const RESOLVED_PACKAGE_ROOTS = { saxes: resolvedPackageRoot("saxes"), xmlchars: resolvedPackageRoot("xmlchars") }
const SAX_LOCK_INTEGRITY = {
  saxes: "sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==",
  xmlchars: "sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==",
}

function dependencyManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    packages: [
      {
        name: "saxes",
        version: "6.0.0",
        integrity: SAX_LOCK_INTEGRITY.saxes,
        files: ["saxes.js"].map((file) => ({ path: file, sha256: hash(path.join(RESOLVED_PACKAGE_ROOTS.saxes, file)) })),
      },
      {
        name: "xmlchars",
        version: "2.2.0",
        integrity: SAX_LOCK_INTEGRITY.xmlchars,
        files: SAX_RUNTIME_FILES.filter((file) => file.startsWith("xmlchars/")).map((file) => ({
          path: file.slice("xmlchars/".length),
          sha256: hash(path.join(RESOLVED_PACKAGE_ROOTS.xmlchars, file.slice("xmlchars/".length))),
        })),
      },
    ],
  }
}

function dependencyFixture(tree: string, dependencyRoot = tree): void {
  mkdirSync(path.join(dependencyRoot, "node_modules"), { recursive: true })
  for (const packageName of ["saxes", "xmlchars"] as const)
    cpSync(RESOLVED_PACKAGE_ROOTS[packageName], path.join(dependencyRoot, "node_modules", packageName), { recursive: true })
  writeFileSync(path.join(tree, "package.json"), `${JSON.stringify({ dependencies: { saxes: "6.0.0" } }, null, 2)}\n`)
  writeFileSync(
    path.join(tree, "bun.lock"),
    `{
  "lockfileVersion": 1,
  "packages": {
    "saxes": ["saxes@6.0.0", "", { "dependencies": { "xmlchars": "^2.2.0" } }, "${SAX_LOCK_INTEGRITY.saxes}"],
    "xmlchars": ["xmlchars@2.2.0", "", {}, "${SAX_LOCK_INTEGRITY.xmlchars}"]
  }
}\n`,
  )
  json(path.join(tree, DEPENDENCY_INTEGRITY_MANIFEST), dependencyManifest())
}

function commitEntryMutation(f: { tree: string; out: string; entry: string; pointer: string }, mutate: () => void, message: string): void {
  const manifestPath = path.join(f.out, "evidence-manifest.json")
  git(f.tree, ["checkout", "master"])
  mutate()
  git(f.tree, ["add", "--", "package.json", "bun.lock", "scripts", HANDOVER])
  if (existsSync(path.join(f.tree, "node_modules/saxes"))) git(f.tree, ["add", "--force", "--", "node_modules/saxes", "node_modules/xmlchars"])
  git(f.tree, ["commit", "-m", message])
  f.entry = git(f.tree, ["rev-parse", "HEAD"])
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.measured_sha = f.entry
  for (const run of manifest.runs) {
    const log = run.log_path as string
    writeFileSync(log, readFileSync(log, "utf8").replace(/^measured_sha=.*$/m, `measured_sha=${f.entry}`))
    run.log_sha256 = hash(log)
  }
  json(manifestPath, manifest)
  writeFileSync(
    path.join(f.tree, HANDOVER),
    `<!-- entry-evidence-pointer:v1 -->\nentry_sha=${f.entry}\nmanifest_path=${manifestPath}\nmanifest_sha256=${hash(manifestPath)}\narchive_path=\n<!-- /entry-evidence-pointer:v1 -->\n`,
  )
  git(f.tree, ["add", HANDOVER])
  git(f.tree, ["commit", "-m", `${message} pointer`])
  f.pointer = git(f.tree, ["rev-parse", "HEAD"])
  git(f.tree, ["checkout", "--detach", f.entry])
}

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}
function json(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
function git(tree: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function fixture(options: { unicodeSkips?: boolean; noncanonicalBaseline?: boolean; dependencyLocation?: "tree" | "ancestor" } = {}) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "entry-validator-"))
  const tree = path.join(sandbox, "tree")
  mkdirSync(tree)
  const dependencyRoot = options.dependencyLocation === "ancestor" ? sandbox : tree
  const unicodeSkips = options.unicodeSkips === true
  const allowedSkipped = unicodeSkips
    ? [
        { kind: "suite", file: "tests/a.unit.test.ts", suite_name: "套件", count: 1, reason: "whole-suite-skip" },
        { kind: "testcase", file: "tests/a.unit.test.ts", classname: "类", name: "跳过", ordinal: 1, count: 1, reason: "todo" },
      ].sort((left, right) => Buffer.from(JSON.stringify(left)).compare(Buffer.from(JSON.stringify(right))))
    : ([] as Array<unknown>)
  const out = mkdtempSync(path.join(os.tmpdir(), "entry-validator-out-"))
  mkdirSync(path.join(tree, path.dirname(HANDOVER)), { recursive: true })
  mkdirSync(path.join(tree, "tests/infra"), { recursive: true })
  mkdirSync(path.join(tree, "tests"), { recursive: true })
  mkdirSync(path.join(tree, "scripts"), { recursive: true })
  writeFileSync(path.join(tree, "tests/a.unit.test.ts"), "")
  writeFileSync(path.join(tree, "scripts/parallel-test.ts"), "export {}\n")
  for (const script of [
    "validate-entry-evidence.ts",
    "entry-evidence-runtime-closure.ts",
    "entry-evidence-receipt.ts",
    "entry-evidence-schema.ts",
    "parallel-test-artifacts.ts",
  ])
    writeFileSync(path.join(tree, "scripts", script), readFileSync(path.join(REPO_ROOT, "scripts", script)))
  dependencyFixture(tree, dependencyRoot)
  git(tree, ["init", "-b", "master"])
  git(tree, ["config", "user.email", "x@example.invalid"])
  git(tree, ["config", "user.name", "Test"])
  const runner = git(tree, ["hash-object", "scripts/parallel-test.ts"])
  const baselinePath = path.join(tree, BASELINE)
  json(baselinePath, {
    schema_version: 1,
    runner_git_blob: runner,
    minimum_executed: unicodeSkips ? 0 : 1,
    files: ["tests/a.unit.test.ts"],
    allowed_skipped: allowedSkipped,
  })
  if (options.noncanonicalBaseline) writeFileSync(baselinePath, readFileSync(baselinePath, "utf8").trimEnd())
  git(tree, ["add", "."])
  git(tree, ["commit", "-m", "entry"])
  const entry = git(tree, ["rev-parse", "HEAD"])
  const disk = path.join(out, "disk.json")
  const runtimeAggregate = path.join(out, "runtime-aggregate.json")
  const skippedAggregate = path.join(out, "skipped-aggregate.json")
  json(disk, { files: ["tests/a.unit.test.ts"] })
  const runs = Array.from({ length: 15 }, (_, i) => {
    const n = i + 1
    const dir = path.join(out, `run-${n}`)
    mkdirSync(dir)
    const junit = path.join(dir, "shard-01.xml")
    const runtime = path.join(dir, "runtime-identity.json")
    const skipped = path.join(dir, "skipped-multiset.json")
    const log = path.join(out, `run-${n}.log`)
    writeFileSync(
      junit,
      unicodeSkips
        ? '<testsuites><testsuite file="tests/a.unit.test.ts" name="套件" skipped="1"/><testcase classname="类" name="跳过" file="tests/a.unit.test.ts"><skipped/></testcase></testsuites>\n'
        : '<testsuites><testcase classname="suite" name="case" file="tests/a.unit.test.ts"/></testsuites>\n',
    )
    json(runtime, { files: ["tests/a.unit.test.ts"] })
    json(skipped, {
      executed: unicodeSkips ? 0 : 1,
      skipped: unicodeSkips ? 2 : 0,
      skipped_identities: unicodeSkips
        ? [
            { kind: "suite", file: "tests/a.unit.test.ts", suite_name: "套件", count: 1 },
            { kind: "testcase", file: "tests/a.unit.test.ts", classname: "类", name: "跳过", ordinal: 1, count: 1 },
          ]
        : [],
    })
    writeFileSync(
      log,
      `canonical_command=bun scripts/parallel-test.ts unit it http\nevidence_timing=closeout\nmeasured_sha=${entry}\nclaims_current_head=true\nverdict=green\nartifact_dir=${dir}\n`,
    )
    return {
      ordinal: n,
      log_path: log,
      log_sha256: hash(log),
      artifact_dir: dir,
      junit_artifacts: [{ path: junit, sha256: hash(junit) }],
      runtime_identity: { path: runtime, sha256: hash(runtime) },
      skipped_multiset: { path: skipped, sha256: hash(skipped) },
      executed: unicodeSkips ? 0 : 1,
      skipped: unicodeSkips ? 2 : 0,
      verdict: "green",
    }
  })
  json(runtimeAggregate, { runs: runs.map(({ ordinal, runtime_identity }) => ({ ordinal, ...runtime_identity })) })
  json(skippedAggregate, { runs: runs.map(({ ordinal, skipped_multiset }) => ({ ordinal, ...skipped_multiset })) })
  const manifest = path.join(out, "evidence-manifest.json")
  json(manifest, {
    schema_version: 1,
    measured_sha: entry,
    evidence_timing: "closeout",
    claims_current_head: true,
    out_dir: out,
    canonical_command: "bun scripts/parallel-test.ts unit it http",
    discovery_baseline_path: BASELINE,
    discovery_baseline_sha256: hash(path.join(tree, BASELINE)),
    discovery_runner_git_blob: runner,
    disk_manifest: { path: disk, sha256: hash(disk) },
    runtime_identity_manifest: { path: runtimeAggregate, sha256: hash(runtimeAggregate) },
    skipped_multiset: { path: skippedAggregate, sha256: hash(skippedAggregate) },
    runs,
  })
  writeFileSync(
    path.join(tree, HANDOVER),
    `<!-- entry-evidence-pointer:v1 -->\nentry_sha=${entry}\nmanifest_path=${manifest}\nmanifest_sha256=${hash(manifest)}\narchive_path=\n<!-- /entry-evidence-pointer:v1 -->\n`,
  )
  git(tree, ["add", HANDOVER])
  git(tree, ["commit", "-m", "pointer"])
  const pointer = git(tree, ["rev-parse", "HEAD"])
  git(tree, ["checkout", "--detach", entry])
  return { tree, dependencyRoot, out, entry, pointer, receipt: path.join(out, "receipt.json") }
}

function invoke(f: ReturnType<typeof fixture>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      "bun",
      path.join(f.tree, "scripts/validate-entry-evidence.ts"),
      "--entry-sha",
      f.entry,
      "--pointer-sha",
      f.pointer,
      "--tree",
      f.tree,
      "--handover",
      HANDOVER,
      "--receipt-out",
      f.receipt,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
}

function error(result: ReturnType<typeof Bun.spawnSync>): string {
  return new TextDecoder().decode(result.stderr).replaceAll(/\x1b\[[0-9;]*m/g, "")
}

function receiptExpected(f: ReturnType<typeof fixture>, receiptRaw = readFileSync(f.receipt, "utf8")): EntryEvidenceReceiptV1Expected {
  return {
    entrySha: f.entry,
    currentHeadSha: f.entry,
    pointerSha: f.pointer,
    pointerReachableFromMaster: (pointerSha) => pointerSha === f.pointer,
    manifestPath: path.join(f.out, "evidence-manifest.json"),
    manifestSha256: hash(path.join(f.out, "evidence-manifest.json")),
    discoveryBaselinePath: BASELINE,
    discoveryBaselineSha256: hash(path.join(f.tree, BASELINE)),
    discoveryRunnerGitBlob: git(f.tree, ["rev-parse", `${f.entry}:scripts/parallel-test.ts`]),
    validatorGitBlob: git(f.tree, ["rev-parse", `${f.entry}:scripts/validate-entry-evidence.ts`]),
    receiptSha256: createHash("sha256").update(receiptRaw).digest("hex"),
    tree: f.tree,
  }
}

function receiptRawWith(f: ReturnType<typeof fixture>, change: (receipt: Record<string, unknown>) => void): string {
  const receipt = JSON.parse(readFileSync(f.receipt, "utf8")) as Record<string, unknown>
  change(receipt)
  return `${JSON.stringify(receipt, null, 2)}\n`
}

function refreshLogHash(f: ReturnType<typeof fixture>): void {
  const manifestPath = path.join(f.out, "evidence-manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.runs[0].log_sha256 = hash(manifest.runs[0].log_path)
  json(manifestPath, manifest)
  git(f.tree, ["checkout", "master"])
  const pointerPath = path.join(f.tree, HANDOVER)
  writeFileSync(pointerPath, readFileSync(pointerPath, "utf8").replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${hash(manifestPath)}`))
  git(f.tree, ["add", HANDOVER])
  git(f.tree, ["commit", "-m", "refresh pointer"])
  const pointer = git(f.tree, ["rev-parse", "HEAD"])
  git(f.tree, ["checkout", "--detach", f.entry])
  f.pointer = pointer
}

function mutateLog(f: ReturnType<typeof fixture>, field: string, value: string): void {
  const log = path.join(f.out, "run-1.log")
  writeFileSync(log, readFileSync(log, "utf8").replace(new RegExp(`^${field}=.*$`, "m"), `${field}=${value}`))
  refreshLogHash(f)
}

function mutateTopLevelArtifact(f: ReturnType<typeof fixture>, field: "disk_manifest" | "runtime_identity_manifest" | "skipped_multiset"): void {
  const manifestPath = path.join(f.out, "evidence-manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  writeFileSync(manifest[field].path, `${field} mutated\n`)
}

function mutateManifest(f: ReturnType<typeof fixture>, mutate: (manifest: Record<string, unknown>) => void): void {
  const manifestPath = path.join(f.out, "evidence-manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  mutate(manifest)
  json(manifestPath, manifest)
  git(f.tree, ["checkout", "master"])
  const pointerPath = path.join(f.tree, HANDOVER)
  writeFileSync(pointerPath, readFileSync(pointerPath, "utf8").replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${hash(manifestPath)}`))
  git(f.tree, ["add", HANDOVER])
  git(f.tree, ["commit", "-m", "refresh manifest pointer"])
  f.pointer = git(f.tree, ["rev-parse", "HEAD"])
  git(f.tree, ["checkout", "--detach", f.entry])
}

function createEv27EntryGraph(f: ReturnType<typeof fixture>): void {
  const manifestPath = path.join(f.out, "evidence-manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const oldBaselineHash = manifest.discovery_baseline_sha256
  git(f.tree, ["checkout", "master"])
  const baselinePath = path.join(f.tree, BASELINE)
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  baseline.minimum_executed = 2
  json(baselinePath, baseline)
  git(f.tree, ["add", BASELINE])
  git(f.tree, ["commit", "-m", "entry A2"])
  f.entry = git(f.tree, ["rev-parse", "HEAD"])
  manifest.measured_sha = f.entry
  for (const run of manifest.runs) {
    const log = run.log_path as string
    writeFileSync(log, readFileSync(log, "utf8").replace(/^measured_sha=.*$/m, `measured_sha=${f.entry}`))
    run.log_sha256 = hash(log)
  }
  manifest.discovery_baseline_sha256 = oldBaselineHash
  json(manifestPath, manifest)
  const pointerPath = path.join(f.tree, HANDOVER)
  writeFileSync(
    pointerPath,
    `<!-- entry-evidence-pointer:v1 -->\nentry_sha=${f.entry}\nmanifest_path=${manifestPath}\nmanifest_sha256=${hash(manifestPath)}\narchive_path=\n<!-- /entry-evidence-pointer:v1 -->\n`,
  )
  git(f.tree, ["add", HANDOVER])
  git(f.tree, ["commit", "-m", "pointer P2"])
  f.pointer = git(f.tree, ["rev-parse", "HEAD"])
  git(f.tree, ["checkout", "--detach", f.entry])
}

function cleanup(f: ReturnType<typeof fixture>): void {
  rmSync(path.dirname(f.tree), { recursive: true, force: true })
  rmSync(f.out, { recursive: true, force: true })
}

interface PlanMutationRow {
  id: string
  condition: string
  action: string
  expectedStderr: string
  expectedExit: number
}
const EXPECTED_EXIT: Record<string, number> = { C1: 3, C2: 3, C3: 3, C4: 3, C5: 4, C6: 5, C7: 6, C8: 6, C9: 7, C10: 7, C11: 7 }
const FROZEN_MUTATION_COUNTS = "condition coverage: C1=2 C2=2 C3=3 C4=3 C5=2 C6=3 C7=1 C8=1 C9=5 C10=3 C11=3"
const EXECUTED_MUTATIONS: Array<{ id: string; condition: string }> = []
const PLAN_MUTATIONS = (() => {
  const plan = readFileSync(path.join(REPO_ROOT, "docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md"), "utf8")
  const rows = [...plan.matchAll(/^\| `(?<id>EV-\d{2})` \| (?<condition>\d+) \| (?<action>.*?) \| `(?<stderr>FAIL C\d+: .*?)` \|$/gm)].map((match) => {
    const condition = `C${match.groups!.condition}`
    return {
      id: match.groups!.id,
      condition,
      action: match.groups!.action,
      expectedStderr: `${match.groups!.stderr}\n`,
      expectedExit: EXPECTED_EXIT[condition],
    }
  })
  if (rows.length !== 28 || new Set(rows.map((row) => row.id)).size !== 28 || rows.some((row) => /／|分别|之一|任一/.test(row.action)))
    throw new Error("frozen plan mutation table invalid")
  return new Map(rows.map((row) => [row.id, row]))
})()
function expectEv(id: string, result: { exitCode: number; stderr?: Uint8Array }, executions = EXECUTED_MUTATIONS): void {
  const row = PLAN_MUTATIONS.get(id)
  if (!row || executions.some((entry) => entry.id === id)) throw new Error(`unknown or duplicate execution: ${id}`)
  expect(result.exitCode).toBe(row.expectedExit)
  expect(new TextDecoder().decode(result.stderr ?? new Uint8Array()).replaceAll(/\x1b\[[0-9;]*m/g, "")).toBe(row.expectedStderr)
  executions.push({ id, condition: row.condition })
}
function reconcileExecuted(planRows: ReadonlyMap<string, PlanMutationRow>, executions: ReadonlyArray<{ id: string; condition: string }>): Array<string> {
  const counts = new Map<string, number>(),
    ids = new Set<string>(),
    duplicate = new Set<string>()
  for (const entry of executions) {
    if (ids.has(entry.id)) duplicate.add(entry.id)
    ids.add(entry.id)
    counts.set(entry.condition, (counts.get(entry.condition) ?? 0) + 1)
  }
  const missing = [...planRows.keys()].filter((id) => !ids.has(id)),
    orphan = [...ids].filter((id) => !planRows.has(id)),
    wrong = executions.filter((entry) => planRows.get(entry.id)?.condition !== entry.condition)
  if (missing.length || duplicate.size || orphan.length || wrong.length)
    throw new Error(
      `mutation reconciliation failed: missing=${missing.join(",")} duplicate=${[...duplicate].join(",")} orphan=${orphan.join(",")} wrong_condition=${wrong.map((entry) => entry.id).join(",")}`,
    )
  return [
    `condition coverage: ${["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11"].map((condition) => `${condition}=${counts.get(condition) ?? 0}`).join(" ")}`,
    `mutation ownership: ${ids.size} IDs each map to exactly one condition`,
    "duplicate IDs: none",
    "orphan IDs: none",
  ]
}

describe("entry evidence validator C7-C9", () => {
  test("generates a deterministic SAX runtime dependency manifest at an explicit output path", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "entry-evidence-dependencies-"))
    const output = path.join(directory, "runtime-dependencies.json")
    try {
      const result = Bun.spawnSync(["bun", path.join(REPO_ROOT, "scripts/generate-entry-evidence-runtime-dependencies.ts"), "--out", output], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(readFileSync(output, "utf8")).toBe(`${JSON.stringify(dependencyManifest(), null, 2)}\n`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects a dirty runtime-closure helper before executing it", () => {
    const f = fixture()
    const sentinel = path.join(f.out, "dirty-helper-executed")
    try {
      const helper = path.join(f.tree, "scripts/entry-evidence-runtime-closure.ts")
      writeFileSync(
        helper,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(sentinel)}, "executed\\n")\n${readFileSync(helper, "utf8")}`,
      )
      const result = invoke(f)
      expect(result.exitCode).toBe(7)
      expect(error(result)).toBe("FAIL C11: validator provenance mismatch\n")
      expect(existsSync(sentinel)).toBe(false)
      expect(existsSync(f.receipt)).toBe(false)
    } finally {
      cleanup(f)
    }
  })

  test("accepts an ancestor-resolved SAX package closure", () => {
    const f = fixture({ dependencyLocation: "ancestor" })
    try {
      const result = invoke(f)
      expect(result.exitCode).toBe(0)
      expect(error(result)).toBe("")
    } finally {
      cleanup(f)
    }
  })

  test("accepts a symlink-like SAX package closure by content identity", () => {
    const f = fixture({ dependencyLocation: "ancestor" })
    const store = path.join(path.dirname(f.tree), "package-store")
    try {
      mkdirSync(store)
      for (const packageName of ["saxes", "xmlchars"] as const) {
        renameSync(path.join(f.dependencyRoot, "node_modules", packageName), path.join(store, packageName))
        symlinkSync(path.join(store, packageName), path.join(f.dependencyRoot, "node_modules", packageName))
      }
      const result = invoke(f)
      expect(result.exitCode).toBe(0)
      expect(error(result)).toBe("")
    } finally {
      cleanup(f)
    }
  })

  test("rejects dirty ancestor SAX package bytes", () => {
    const f = fixture({ dependencyLocation: "ancestor" })
    try {
      writeFileSync(path.join(f.dependencyRoot, "node_modules/saxes/saxes.js"), "module.exports = {}\n")
      const result = invoke(f)
      expect(result.exitCode).toBe(7)
      expect(error(result)).toBe("FAIL C11: validator provenance mismatch\n")
      expect(existsSync(f.receipt)).toBe(false)
    } finally {
      cleanup(f)
    }
  })

  test("rejects an unmanifested transitive runtime import discovered from actual package bytes", () => {
    const f = fixture({ dependencyLocation: "ancestor" })
    try {
      const packageRoot = path.join(f.dependencyRoot, "node_modules/saxes")
      writeFileSync(path.join(packageRoot, "unexpected.js"), "module.exports = {}\n")
      writeFileSync(path.join(packageRoot, "saxes.js"), `${readFileSync(path.join(packageRoot, "saxes.js"), "utf8")}\nrequire("./unexpected")\n`)
      commitEntryMutation(
        f,
        () => {
          const manifest = JSON.parse(readFileSync(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), "utf8"))
          manifest.packages[0].files[0].sha256 = hash(path.join(packageRoot, "saxes.js"))
          json(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), manifest)
        },
        "bind mutated package entry",
      )
      const result = invoke(f)
      expect(result.exitCode).toBe(7)
      expect(error(result)).toBe("FAIL C11: validator provenance mismatch\n")
      expect(existsSync(f.receipt)).toBe(false)
    } finally {
      cleanup(f)
    }
  })

  test("rejects an unexpected transitive package absent from the ENTRY manifest", () => {
    const f = fixture({ dependencyLocation: "ancestor" })
    try {
      const saxesRoot = path.join(f.dependencyRoot, "node_modules/saxes")
      const unexpectedRoot = path.join(f.dependencyRoot, "node_modules/unexpected-runtime-package")
      mkdirSync(unexpectedRoot)
      json(path.join(unexpectedRoot, "package.json"), { name: "unexpected-runtime-package", version: "1.0.0", main: "index.js" })
      writeFileSync(path.join(unexpectedRoot, "index.js"), "module.exports = {}\n")
      writeFileSync(path.join(saxesRoot, "saxes.js"), `${readFileSync(path.join(saxesRoot, "saxes.js"), "utf8")}\nrequire("unexpected-runtime-package")\n`)
      commitEntryMutation(
        f,
        () => {
          const manifest = JSON.parse(readFileSync(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), "utf8"))
          manifest.packages[0].files[0].sha256 = hash(path.join(saxesRoot, "saxes.js"))
          json(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), manifest)
        },
        "bind package with unexpected transitive dependency",
      )
      const result = invoke(f)
      expect(result.exitCode).toBe(7)
      expect(error(result)).toBe("FAIL C11: validator provenance mismatch\n")
      expect(existsSync(f.receipt)).toBe(false)
    } finally {
      cleanup(f)
    }
  })

  test("rejects an extra manifest package absent from the observed closure", () => {
    const f = fixture()
    try {
      commitEntryMutation(
        f,
        () => {
          const manifest = JSON.parse(readFileSync(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), "utf8"))
          manifest.packages.push({
            name: "unexpected-runtime-package",
            version: "1.0.0",
            integrity: "sha512-unexpected",
            files: [{ path: "index.js", sha256: "0".repeat(64) }],
          })
          json(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), manifest)
        },
        "add absent manifest package",
      )
      const result = invoke(f)
      expect(result.exitCode).toBe(7)
      expect(error(result)).toBe("FAIL C11: validator provenance mismatch\n")
      expect(existsSync(f.receipt)).toBe(false)
    } finally {
      cleanup(f)
    }
  })

  test("accepts aggregate disk/runtime/skipped populations that agree with raw artifacts", () => {
    const f = fixture()
    try {
      const result = invoke(f)
      expect(result.exitCode).toBe(0)
      expect(error(result)).toBe("")
      expect(new TextDecoder().decode(result.stdout)).toMatch(
        new RegExp(`^receipt=${f.receipt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nreceipt_sha256=[0-9a-f]{64}\\n$`),
      )
      const receipt = JSON.parse(readFileSync(f.receipt, "utf8"))
      expect(Object.keys(receipt)).toEqual([
        "schema_version",
        "validator_path",
        "validator_git_blob",
        "entry_sha",
        "pointer_sha",
        "manifest_path",
        "manifest_sha256",
        "discovery_baseline_path",
        "discovery_baseline_sha256",
        "discovery_runner_git_blob",
        "validated_at",
        "verdict",
      ])
      expect(receipt).toMatchObject({ schema_version: 1, entry_sha: f.entry, pointer_sha: f.pointer, verdict: "green" })
      expect(receipt.validated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    } finally {
      cleanup(f)
    }
  })

  test("rejects receipt v1 tampering against independently supplied T0.1 facts", () => {
    const f = fixture()
    try {
      expect(invoke(f).exitCode).toBe(0)
      const correct = readFileSync(f.receipt, "utf8")
      expect(JSON.parse(correct).pointer_sha).toBe(f.pointer)
      expect(validateEntryEvidenceReceiptV1(correct, receiptExpected(f))).toMatchObject({ valid: true, errors: [] })

      const tampering: Array<[string, (receipt: Record<string, unknown>) => void]> = [
        ["missing field", (receipt) => delete receipt.verdict],
        ["extra field", (receipt) => (receipt.unexpected = true)],
        ["schema_version type", (receipt) => (receipt.schema_version = "1")],
        ["schema_version", (receipt) => (receipt.schema_version = 2)],
        ["validator_path type", (receipt) => (receipt.validator_path = 7)],
        ["validator_path", (receipt) => (receipt.validator_path = "scripts/other.ts")],
        ["validator_git_blob type", (receipt) => (receipt.validator_git_blob = 7)],
        ["validator_git_blob", (receipt) => (receipt.validator_git_blob = "0".repeat(40))],
        ["entry_sha type", (receipt) => (receipt.entry_sha = 7)],
        ["entry_sha", (receipt) => (receipt.entry_sha = "0".repeat(40))],
        ["pointer_sha type", (receipt) => (receipt.pointer_sha = 7)],
        ["pointer_sha", (receipt) => (receipt.pointer_sha = "0".repeat(40))],
        ["manifest_path type", (receipt) => (receipt.manifest_path = 7)],
        ["manifest_path", (receipt) => (receipt.manifest_path = path.join(f.tree, "evidence-manifest.json"))],
        ["manifest_sha256 type", (receipt) => (receipt.manifest_sha256 = 7)],
        ["manifest_sha256", (receipt) => (receipt.manifest_sha256 = "0".repeat(64))],
        ["baseline path type", (receipt) => (receipt.discovery_baseline_path = 7)],
        ["baseline path", (receipt) => (receipt.discovery_baseline_path = "tests/other.json")],
        ["baseline hash type", (receipt) => (receipt.discovery_baseline_sha256 = 7)],
        ["baseline hash", (receipt) => (receipt.discovery_baseline_sha256 = "0".repeat(64))],
        ["runner blob type", (receipt) => (receipt.discovery_runner_git_blob = 7)],
        ["runner blob", (receipt) => (receipt.discovery_runner_git_blob = "0".repeat(40))],
        ["validated_at type", (receipt) => (receipt.validated_at = 7)],
        ["validated_at", (receipt) => (receipt.validated_at = "2026-02-30T00:00:00Z")],
        ["verdict type", (receipt) => (receipt.verdict = 7)],
        ["verdict", (receipt) => (receipt.verdict = "red")],
      ]
      expect(validateEntryEvidenceReceiptV1("{", receiptExpected(f)).valid).toBe(false)
      expect(validateEntryEvidenceReceiptV1(`${correct}\n`, receiptExpected(f)).valid).toBe(false)
      for (const timestamp of [
        "2023-02-29T00:00:00Z",
        "2026-02-30T00:00:00Z",
        "2024-02-30T00:00:00Z",
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:00+01:60",
      ]) {
        const raw = receiptRawWith(f, (receipt) => (receipt.validated_at = timestamp))
        expect(validateEntryEvidenceReceiptV1(raw, receiptExpected(f, raw)).valid, timestamp).toBe(false)
      }
      const leapDayRaw = receiptRawWith(f, (receipt) => (receipt.validated_at = "2024-02-29T00:00:00+05:30"))
      expect(validateEntryEvidenceReceiptV1(leapDayRaw, receiptExpected(f, leapDayRaw)).valid).toBe(true)
      const leapSecondRaw = receiptRawWith(f, (receipt) => (receipt.validated_at = "1990-12-31T23:59:60Z"))
      expect(validateEntryEvidenceReceiptV1(leapSecondRaw, receiptExpected(f, leapSecondRaw)).valid).toBe(true)
      const offsetLeapSecondRaw = receiptRawWith(f, (receipt) => (receipt.validated_at = "1991-01-01T00:59:60+01:00"))
      expect(validateEntryEvidenceReceiptV1(offsetLeapSecondRaw, receiptExpected(f, offsetLeapSecondRaw)).valid).toBe(true)
      for (const timestamp of [
        "0072-06-30T23:59:60Z",
        "0072-07-01T00:59:60+01:00",
        "2024-01-01T12:34:60Z",
        "2024-06-30T23:59:60Z",
        "2024-12-31T23:59:60Z",
        "1990-12-31T23:58:60Z",
        "2024-01-01T00:00:61Z",
        "2024-01-01T24:00:00Z",
        "2024-01-01T00:00:00+24:00",
        "2024-01-01T00:00:00+01:60",
        "2024-01-01T00:00:00.Z",
        "2024-01-01T00:00:00. Z",
      ]) {
        const raw = receiptRawWith(f, (receipt) => (receipt.validated_at = timestamp))
        expect(validateEntryEvidenceReceiptV1(raw, receiptExpected(f, raw)).valid, timestamp).toBe(false)
      }
      for (const [label, tamper] of tampering) {
        const raw = receiptRawWith(f, tamper)
        expect(validateEntryEvidenceReceiptV1(raw, receiptExpected(f, raw)).valid, label).toBe(false)
      }
      expect(validateEntryEvidenceReceiptV1(correct, { ...receiptExpected(f), receiptSha256: "0".repeat(64) }).valid).toBe(false)
      expect(validateEntryEvidenceReceiptV1(correct, { ...receiptExpected(f), currentHeadSha: "0".repeat(40) }).valid).toBe(false)
      expect(validateEntryEvidenceReceiptV1(correct, { ...receiptExpected(f), pointerReachableFromMaster: () => false }).valid).toBe(false)
      expect(validateEntryEvidenceReceiptV1(correct, { ...receiptExpected(f), pointerSha: "0".repeat(40) }).valid).toBe(false)

      const observedPointerShas: string[] = []
      expect(
        validateEntryEvidenceReceiptV1(correct, {
          ...receiptExpected(f),
          pointerReachableFromMaster: (pointerSha) => {
            observedPointerShas.push(pointerSha)
            return pointerSha === f.pointer
          },
        }).valid,
      ).toBe(true)
      expect(observedPointerShas).toEqual([f.pointer])
      const tamperedPointerRaw = receiptRawWith(f, (receipt) => (receipt.pointer_sha = "0".repeat(40)))
      const observedTamperedPointerShas: string[] = []
      expect(
        validateEntryEvidenceReceiptV1(tamperedPointerRaw, {
          ...receiptExpected(f, tamperedPointerRaw),
          pointerReachableFromMaster: (pointerSha) => {
            observedTamperedPointerShas.push(pointerSha)
            return false
          },
        }).valid,
      ).toBe(false)
      expect(observedTamperedPointerShas).toEqual(["0".repeat(40)])
      expect(
        validateEntryEvidenceReceiptV1(tamperedPointerRaw, {
          ...receiptExpected(f, tamperedPointerRaw),
          pointerReachableFromMaster: () => true,
        }).valid,
      ).toBe(false)

      const insideManifest = path.join(f.tree, "inside-manifest.json")
      writeFileSync(insideManifest, "{}\n")
      const insideLink = path.join(f.out, "inside-link")
      symlinkSync(insideManifest, insideLink)
      const insideReceiptRaw = receiptRawWith(f, (receipt) => (receipt.manifest_path = insideLink))
      const insideContainment = validateEntryEvidenceReceiptV1(insideReceiptRaw, { ...receiptExpected(f, insideReceiptRaw), manifestPath: insideLink })
      expect(insideContainment.valid).toBe(false)
      expect(insideContainment.errors).toContain("manifest_path is invalid for tree")

      const nonexistentManifest = path.join(f.out, "missing-manifest.json")
      const nonexistentReceiptRaw = receiptRawWith(f, (receipt) => (receipt.manifest_path = nonexistentManifest))
      expect(
        validateEntryEvidenceReceiptV1(nonexistentReceiptRaw, { ...receiptExpected(f, nonexistentReceiptRaw), manifestPath: nonexistentManifest }).valid,
      ).toBe(false)

      const directoryReceiptRaw = receiptRawWith(f, (receipt) => (receipt.manifest_path = f.out))
      expect(validateEntryEvidenceReceiptV1(directoryReceiptRaw, { ...receiptExpected(f, directoryReceiptRaw), manifestPath: f.out }).valid).toBe(false)

      const treeReceiptRaw = receiptRawWith(f, (receipt) => (receipt.manifest_path = f.tree))
      expect(validateEntryEvidenceReceiptV1(treeReceiptRaw, { ...receiptExpected(f, treeReceiptRaw), manifestPath: f.tree }).valid).toBe(false)

      const outsideLink = path.join(f.out, "outside-link")
      symlinkSync(f.out, outsideLink)
      const outsideReceiptRaw = receiptRawWith(f, (receipt) => (receipt.manifest_path = path.join(outsideLink, "evidence-manifest.json")))
      expect(
        validateEntryEvidenceReceiptV1(outsideReceiptRaw, {
          ...receiptExpected(f, outsideReceiptRaw),
          manifestPath: path.join(outsideLink, "evidence-manifest.json"),
        }).valid,
      ).toBe(true)
    } finally {
      cleanup(f)
    }
  })

  test("accepts reordered non-ASCII testcase and suite skipped identities", () => {
    const f = fixture({ unicodeSkips: true })
    try {
      const result = invoke(f)
      expect(result.exitCode).toBe(0)
      expect(error(result)).toBe("")
    } finally {
      cleanup(f)
    }
  })

  test("rejects a non-ASCII skipped identity multiplicity mismatch", () => {
    const f = fixture({ unicodeSkips: true })
    try {
      const skippedPath = path.join(f.out, "run-1", "skipped-multiset.json")
      const skipped = JSON.parse(readFileSync(skippedPath, "utf8"))
      skipped.skipped_identities[0].count = 2
      json(skippedPath, skipped)
      mutateManifest(f, (manifest) => {
        ;((manifest.runs as Array<Record<string, unknown>>)[0].skipped_multiset as Record<string, unknown>).sha256 = hash(skippedPath)
      })
      expect(error(invoke(f))).toBe("FAIL C8: skipped identity multiset mismatch\n")
    } finally {
      cleanup(f)
    }
  })

  test("rejects an ENTRY baseline with canonical bytes missing its final newline", () => {
    const f = fixture({ noncanonicalBaseline: true })
    try {
      expect(error(invoke(f))).toBe("FAIL C11: discovery baseline hash mismatch\n")
    } finally {
      cleanup(f)
    }
  })

  test("rejects an executing validator whose bytes differ from ENTRY_SHA", () => {
    const f = fixture()
    try {
      const validatorPath = path.join(f.tree, "scripts/validate-entry-evidence.ts")
      writeFileSync(validatorPath, `${readFileSync(validatorPath, "utf8")}\n// modified\n`)
      expect(error(invoke(f))).toBe("FAIL C11: validator provenance mismatch\n")
    } finally {
      cleanup(f)
    }
  })

  test("rejects every missing or modified runtime dependency before receipt publication", () => {
    for (const dependency of ["entry-evidence-runtime-closure.ts", "entry-evidence-receipt.ts", "entry-evidence-schema.ts", "parallel-test-artifacts.ts"]) {
      for (const mutate of [
        (dependencyPath: string) => writeFileSync(dependencyPath, `${readFileSync(dependencyPath, "utf8")}\n// modified\n`),
        (dependencyPath: string) => unlinkSync(dependencyPath),
      ]) {
        const f = fixture()
        try {
          mutate(path.join(f.tree, "scripts", dependency))
          const result = invoke(f)
          expect(result.exitCode).toBe(7)
          expect(error(result)).toBe("FAIL C11: validator provenance mismatch\n")
          expect(existsSync(f.receipt)).toBe(false)
        } finally {
          cleanup(f)
        }
      }
    }
  })

  test("rejects a same-line unexpected local dynamic import", () => {
    for (const [name, mutate] of [
      [
        "unexpected local import",
        (source: string) =>
          source.replace(
            'const junit = await import("./parallel-test-artifacts")',
            'const junit = await import("./parallel-test-artifacts"); await import("./unexpected-runtime")',
          ),
      ],
    ] as const) {
      const drift = fixture()
      try {
        const validatorPath = path.join(drift.tree, "scripts/validate-entry-evidence.ts")
        commitEntryMutation(drift, () => writeFileSync(validatorPath, mutate(readFileSync(validatorPath, "utf8"))), `entry ${name}`)
        const result = invoke(drift)
        expect(result.exitCode, name).toBe(7)
        expect(error(result), name).toBe("FAIL C11: validator provenance mismatch\n")
        expect(existsSync(drift.receipt), name).toBe(false)
      } finally {
        cleanup(drift)
      }
    }
  })

  test("requires the bound SAX package graph and dependency integrity manifest", () => {
    const controls = [
      ["dirty saxes bytes", (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.tree, "node_modules/saxes/saxes.js"), "module.exports = {}\n")],
      [
        "wrong saxes version",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(
            f,
            () => writeFileSync(path.join(f.tree, "node_modules/saxes/package.json"), `${JSON.stringify({ name: "saxes", version: "6.0.1" })}\n`),
            "wrong saxes version",
          ),
      ],
      [
        "wrong direct package dependency",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(
            f,
            () => writeFileSync(path.join(f.tree, "package.json"), `${JSON.stringify({ dependencies: { saxes: "6.0.1" } }, null, 2)}\n`),
            "wrong direct package dependency",
          ),
      ],
      [
        "wrong lock integrity",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(
            f,
            () =>
              writeFileSync(
                path.join(f.tree, "bun.lock"),
                readFileSync(path.join(f.tree, "bun.lock"), "utf8").replace(SAX_LOCK_INTEGRITY.saxes, "sha512-invalid"),
              ),
            "wrong lock integrity",
          ),
      ],
      [
        "missing dependency manifest",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(f, () => unlinkSync(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST)), "missing dependency manifest"),
      ],
      [
        "altered dependency manifest",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(f, () => writeFileSync(path.join(f.tree, DEPENDENCY_INTEGRITY_MANIFEST), "{}\n"), "altered dependency manifest"),
      ],
      [
        "unexpected helper bare import",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(
            f,
            () => {
              const parser = path.join(f.tree, "scripts/parallel-test-artifacts.ts")
              writeFileSync(
                parser,
                readFileSync(parser, "utf8").replace(
                  'import { SaxesParser, type SaxesTagNS } from "saxes"',
                  'import { SaxesParser, type SaxesTagNS } from "saxes"\nimport "xmlchars"',
                ),
              )
            },
            "unexpected helper bare import",
          ),
      ],
      [
        "unexpected validator bare import",
        (f: ReturnType<typeof fixture>) =>
          commitEntryMutation(
            f,
            () => {
              const validator = path.join(f.tree, "scripts/validate-entry-evidence.ts")
              writeFileSync(
                validator,
                readFileSync(validator, "utf8").replace(
                  'const junit = await import("./parallel-test-artifacts")',
                  'const junit = await import("./parallel-test-artifacts"); await import("saxes")',
                ),
              )
            },
            "unexpected validator bare import",
          ),
      ],
    ] as const
    for (const [name, control] of controls) {
      const f = fixture()
      try {
        control(f)
        const result = invoke(f)
        expect(result.exitCode, name).toBe(7)
        expect(error(result), name).toBe("FAIL C11: validator provenance mismatch\n")
        expect(existsSync(f.receipt), name).toBe(false)
      } finally {
        cleanup(f)
      }
    }
  })

  test("registry infrastructure parses frozen plan and reconciles fake executions", () => {
    expect(PLAN_MUTATIONS).toHaveLength(28)
    const fake = [...PLAN_MUTATIONS.values()].map((row) => ({ id: row.id, condition: row.condition }))
    const output = reconcileExecuted(PLAN_MUTATIONS, fake)
    expect(output).toEqual([FROZEN_MUTATION_COUNTS, "mutation ownership: 28 IDs each map to exactly one condition", "duplicate IDs: none", "orphan IDs: none"])
    expect(() => reconcileExecuted(PLAN_MUTATIONS, fake.slice(1))).toThrow("missing=EV-01")
    expect(() => reconcileExecuted(PLAN_MUTATIONS, [...fake, fake[0]])).toThrow("duplicate=EV-01")
    expect(() => reconcileExecuted(PLAN_MUTATIONS, [{ ...fake[0], condition: "C2" }, ...fake.slice(1)])).toThrow("wrong_condition=EV-01")
    expect(() => reconcileExecuted(PLAN_MUTATIONS, [...fake, { id: "EV-99", condition: "C1" }])).toThrow("orphan=EV-99")
    const forbidden = new Map(PLAN_MUTATIONS)
    forbidden.set("EV-01", { ...PLAN_MUTATIONS.get("EV-01")!, action: "分别 mutate" })
    expect(() =>
      [...forbidden.values()].some(
        (row) =>
          /／|分别|之一|任一/.test(row.action) &&
          (() => {
            throw new Error(`forbidden action token: ${row.id}`)
          })(),
      ),
    ).toThrow("forbidden action token")
    const executions: Array<{ id: string; condition: string }> = []
    const row = PLAN_MUTATIONS.get("EV-01")!
    expectEv("EV-01", { exitCode: row.expectedExit, stderr: new TextEncoder().encode(row.expectedStderr) }, executions)
    expect(executions).toEqual([{ id: "EV-01", condition: "C1" }])
    expect(() => expectEv("EV-01", { exitCode: row.expectedExit, stderr: new TextEncoder().encode(row.expectedStderr) }, executions)).toThrow(
      "duplicate execution",
    )
  })

  test("EV-01 rejects an unresolved POINTER_SHA", () => {
    const f = fixture()
    try {
      f.pointer = "0".repeat(40)
      expectEv("EV-01", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("EV-14 and EV-15 reject a sixteenth run and a raw log byte mutation", () => {
    const countFixture = fixture()
    try {
      const manifestPath = path.join(countFixture.out, "evidence-manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      manifest.runs.push({ ...manifest.runs[0], ordinal: 16 })
      mutateManifest(countFixture, (target) => Object.assign(target, manifest))
      expectEv("EV-14", invoke(countFixture))
    } finally {
      cleanup(countFixture)
    }
    const hashFixture = fixture()
    try {
      writeFileSync(path.join(hashFixture.out, "run-1.log"), "tampered\n")
      expectEv("EV-15", invoke(hashFixture))
    } finally {
      cleanup(hashFixture)
    }
  })

  function rejectPointerMutations(cases: Array<[string, (text: string, f: ReturnType<typeof fixture>) => string]>): void {
    for (const [id, mutate] of cases) {
      const f = fixture()
      try {
        git(f.tree, ["checkout", "master"])
        const pointerPath = path.join(f.tree, HANDOVER)
        writeFileSync(pointerPath, mutate(readFileSync(pointerPath, "utf8"), f))
        git(f.tree, ["add", HANDOVER])
        git(f.tree, ["commit", "-m", "mutation"])
        f.pointer = git(f.tree, ["rev-parse", "HEAD"])
        git(f.tree, ["checkout", "--detach", f.entry])
        expectEv(id, invoke(f))
      } finally {
        cleanup(f)
      }
    }
  }

  test("EV-03 through EV-05 reject malformed pointer blocks", () => {
    rejectPointerMutations([
      ["EV-03", () => "# no pointer\n"],
      ["EV-04", (text) => `${text}${text}`],
      ["EV-05", (text) => text.replace(/^entry_sha=.*\n/m, "")],
    ])
  })

  test("EV-06 through EV-08 reject missing or mismatched pointer fields", () => {
    rejectPointerMutations([
      ["EV-06", (text) => text.replace(/^manifest_path=.*\n/m, "")],
      ["EV-07", (text) => text.replace(/^manifest_sha256=.*\n/m, "")],
      ["EV-08", (text) => text.replace(/entry_sha=[0-9a-f]{40}/, `entry_sha=${"0".repeat(40)}`)],
    ])
  })

  test("EV-11 and EV-12 reject absent or mismatched manifests", () => {
    rejectPointerMutations([
      ["EV-11", (text, f) => text.replace(/manifest_path=.*/, `manifest_path=${path.join(f.out, "missing.json")}`)],
      ["EV-12", (text) => text.replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${"0".repeat(64)}`)],
    ])
  })

  test("EV-02 rejects a pointer outside master", () => {
    const f = fixture()
    try {
      git(f.tree, ["checkout", "--orphan", "side"])
      writeFileSync(path.join(f.tree, "side"), "x\n")
      git(f.tree, ["add", "side"])
      git(f.tree, ["commit", "-m", "side"])
      f.pointer = git(f.tree, ["rev-parse", "HEAD"])
      git(f.tree, ["checkout", "--detach", f.entry])
      expectEv("EV-02", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("EV-10 rejects an unrelated master pointer", () => {
    const f = fixture()
    try {
      git(f.tree, ["checkout", "master"])
      const pointerText = readFileSync(path.join(f.tree, HANDOVER), "utf8")
      git(f.tree, ["checkout", "--orphan", "replacement"])
      writeFileSync(path.join(f.tree, HANDOVER), pointerText)
      git(f.tree, ["add", HANDOVER])
      git(f.tree, ["commit", "-m", "unrelated pointer"])
      git(f.tree, ["branch", "-f", "master", "HEAD"])
      f.pointer = git(f.tree, ["rev-parse", "HEAD"])
      git(f.tree, ["checkout", "--detach", f.entry])
      expectEv("EV-10", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("EV-09 rejects execution on the pointer commit", () => {
    const f = fixture()
    try {
      git(f.tree, ["checkout", "master"])
      expectEv("EV-09", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("EV-13 rejects a missing run log", () => {
    const f = fixture()
    try {
      rmSync(path.join(f.out, "run-1.log"))
      expectEv("EV-13", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("rejects manifest-side C9 intent, verdict, and artifact-dir disagreement", () => {
    for (const [mutate, expected] of [
      [(manifest: Record<string, unknown>) => (manifest.canonical_command = "wrong"), "FAIL C9: canonical command mismatch\n"],
      [(manifest: Record<string, unknown>) => (manifest.evidence_timing = "wrong"), "FAIL C9: evidence timing mismatch\n"],
      [(manifest: Record<string, unknown>) => (manifest.measured_sha = "wrong"), "FAIL C9: measured SHA mismatch\n"],
      [(manifest: Record<string, unknown>) => (manifest.claims_current_head = false), "FAIL C9: current-head claim mismatch\n"],
      [(manifest: Record<string, unknown>) => ((manifest.runs as Array<Record<string, unknown>>)[0].verdict = "red"), "FAIL C9: run verdict is not green\n"],
      [
        (manifest: Record<string, unknown>) => ((manifest.runs as Array<Record<string, unknown>>)[0].artifact_dir = "/tmp/disagrees"),
        "FAIL C9: artifact directory mismatch\n",
      ],
    ] as const) {
      const f = fixture()
      try {
        mutateManifest(f, mutate)
        expect(error(invoke(f))).toBe(expected)
      } finally {
        cleanup(f)
      }
    }
  })

  test("EV-18 through EV-22 reject one independently refreshed raw log field", () => {
    for (const [id, field, value] of [
      ["EV-18", "canonical_command", "bun scripts/parallel-test.ts unit"],
      ["EV-19", "evidence_timing", "before-closeout"],
      ["EV-20", "measured_sha", "0".repeat(40)],
      ["EV-21", "claims_current_head", "false"],
      ["EV-22", "verdict", "red"],
    ]) {
      const f = fixture()
      try {
        mutateLog(f, field, value)
        expectEv(id, invoke(f))
      } finally {
        cleanup(f)
      }
    }
  })

  test("rejects aggregate populations that self-hash but disagree with raw artifacts", () => {
    for (const field of ["disk_manifest", "runtime_identity_manifest", "skipped_multiset"] as const) {
      const f = fixture()
      try {
        const manifestPath = path.join(f.out, "evidence-manifest.json")
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
        const aggregatePath = (manifest[field] as Record<string, string>).path
        const aggregate = JSON.parse(readFileSync(aggregatePath, "utf8")) as Record<string, unknown>
        if (field === "disk_manifest") aggregate.files = ["tests/coordinated-tamper.unit.test.ts"]
        else (aggregate.runs as Array<Record<string, unknown>>)[0].path = path.join(f.out, "coordinated-tamper.json")
        json(aggregatePath, aggregate)
        ;(manifest[field] as Record<string, string>).sha256 = hash(aggregatePath)
        json(manifestPath, manifest)
        git(f.tree, ["checkout", "master"])
        const pointerPath = path.join(f.tree, HANDOVER)
        writeFileSync(pointerPath, readFileSync(pointerPath, "utf8").replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${hash(manifestPath)}`))
        git(f.tree, ["add", HANDOVER])
        git(f.tree, ["commit", "-m", "refresh coordinated aggregate pointer"])
        f.pointer = git(f.tree, ["rev-parse", "HEAD"])
        git(f.tree, ["checkout", "--detach", f.entry])
        const result = invoke(f)
        expect(result.exitCode).toBe(7)
        expect(error(result)).toBe("FAIL C10: aggregate artifact mismatch\n")
      } finally {
        cleanup(f)
      }
    }
  })

  test("EV-23 through EV-25 reject each independently mutated top-level artifact", () => {
    for (const [id, field] of [
      ["EV-23", "disk_manifest"],
      ["EV-24", "runtime_identity_manifest"],
      ["EV-25", "skipped_multiset"],
    ] as const) {
      const f = fixture()
      try {
        mutateTopLevelArtifact(f, field)
        expectEv(id, invoke(f))
      } finally {
        cleanup(f)
      }
    }
  })

  test("EV-26 and EV-28 reject manifest baseline bindings", () => {
    for (const [id, mutate] of [
      ["EV-26", (manifest: Record<string, unknown>) => (manifest.discovery_baseline_path = "tests/infra/other.json")],
      ["EV-28", (manifest: Record<string, unknown>) => (manifest.discovery_runner_git_blob = "0".repeat(40))],
    ] as const) {
      const f = fixture()
      try {
        mutateManifest(f, mutate)
        expectEv(id, invoke(f))
      } finally {
        cleanup(f)
      }
    }
  })

  test("EV-27 changes ENTRY baseline bytes while preserving the manifest hash", () => {
    const f = fixture()
    try {
      createEv27EntryGraph(f)
      expectEv("EV-27", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("preserves old receipt and emits rc8 on no-replace collision", () => {
    const f = fixture()
    try {
      writeFileSync(f.receipt, "old receipt\n")
      const result = invoke(f)
      expect(result.exitCode).toBe(8)
      expect(error(result)).toBe("FAIL receipt: receipt write failed\n")
      expect(readFileSync(f.receipt, "utf8")).toBe("old receipt\n")
    } finally {
      cleanup(f)
    }
  })

  test("maps missing artifact paths to stable C7/C8", () => {
    for (const [, condition, mutate] of [
      [
        "artifact_dir",
        "C7",
        (f: ReturnType<typeof fixture>) => {
          const missing = path.join(f.out, "missing-dir")
          mutateManifest(f, (manifest) => {
            ;(manifest.runs as Array<Record<string, unknown>>)[0].artifact_dir = missing
          })
          mutateLog(f, "artifact_dir", missing)
        },
      ],
      ["junit", "C7", (f: ReturnType<typeof fixture>) => rmSync(path.join(f.out, "run-1", "shard-01.xml"))],
      ["runtime", "C7", (f: ReturnType<typeof fixture>) => rmSync(path.join(f.out, "run-1", "runtime-identity.json"))],
      ["skipped", "C8", (f: ReturnType<typeof fixture>) => rmSync(path.join(f.out, "run-1", "skipped-multiset.json"))],
    ] as const) {
      const f = fixture()
      try {
        mutate(f)
        const result = invoke(f)
        expect(result.exitCode).toBe(6)
        expect(error(result)).toStartWith(`FAIL ${condition}: `)
      } finally {
        cleanup(f)
      }
    }
  })

  test("rejects malformed skipped identity union arms", () => {
    for (const mutate of [
      (value: Record<string, unknown>) =>
        (value.skipped_identities = [{ kind: "testcase", file: "tests/a.unit.test.ts", classname: "x", name: "y", ordinal: 1, count: 1, suite_name: "bad" }]),
      (value: Record<string, unknown>) =>
        (value.skipped_identities = [{ kind: "testcase", file: "tests/a.unit.test.ts", classname: "x", name: "y", ordinal: 0, count: 1 }]),
      (value: Record<string, unknown>) =>
        (value.skipped_identities = [{ kind: "testcase", file: "tests/a.unit.test.ts", classname: "x", name: "y", ordinal: 1, count: 0 }]),
      (value: Record<string, unknown>) =>
        (value.skipped_identities = [{ kind: "suite", file: "tests/a.unit.test.ts", suite_name: "s", count: 1, classname: "bad" }]),
      (value: Record<string, unknown>) => (value.skipped_identities = [{ kind: "suite", file: "tests/a.unit.test.ts", suite_name: "s", count: 0 }]),
      (value: Record<string, unknown>) => (value.skipped_identities = [{ kind: "unknown", file: "tests/a.unit.test.ts", count: 1, extra: true }]),
    ]) {
      const f = fixture()
      try {
        const file = path.join(f.out, "run-1", "skipped-multiset.json")
        const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
        mutate(value)
        json(file, value)
        mutateManifest(f, (manifest) => {
          ;((manifest.runs as Array<Record<string, unknown>>)[0].skipped_multiset as Record<string, unknown>).sha256 = hash(file)
        })
        const result = invoke(f)
        expect(result.exitCode).toBe(6)
        expect(error(result)).toBe("FAIL C8: skipped identity multiset mismatch\n")
      } finally {
        cleanup(f)
      }
    }
  })

  test("maps per-run directory artifacts to their stable C7/C8 boundaries", () => {
    for (const [field, condition, message] of [
      ["junit_artifacts", "C7", "JUnit file identity mismatch"],
      ["runtime_identity", "C7", "JUnit file identity mismatch"],
      ["skipped_multiset", "C8", "skipped identity multiset mismatch"],
    ] as const) {
      const f = fixture()
      try {
        mutateManifest(f, (manifest) => {
          const run = (manifest.runs as Array<Record<string, unknown>>)[0]
          if (field === "junit_artifacts") (run[field] as Array<Record<string, unknown>>)[0].path = run.artifact_dir
          else (run[field] as Record<string, unknown>).path = run.artifact_dir
        })
        const result = invoke(f)
        expect(result.exitCode).toBe(6)
        expect(error(result)).toBe(`FAIL ${condition}: ${message}\n`)
        expect(existsSync(f.receipt)).toBe(false)
      } finally {
        cleanup(f)
      }
    }
  })

  test("rejects nested same-basename artifacts while accepting direct-child symlink targets", () => {
    for (const [field, condition, message, basename] of [
      ["junit_artifacts", "C7", "JUnit file identity mismatch", "shard-01.xml"],
      ["runtime_identity", "C7", "JUnit file identity mismatch", "runtime-identity.json"],
      ["skipped_multiset", "C8", "skipped identity multiset mismatch", "skipped-multiset.json"],
    ] as const) {
      const f = fixture()
      try {
        const nested = path.join(f.out, "run-1", "nested")
        mkdirSync(nested)
        const source = path.join(f.out, "run-1", basename)
        const replacement = path.join(nested, basename)
        writeFileSync(replacement, readFileSync(source))
        mutateManifest(f, (manifest) => {
          const artifact =
            field === "junit_artifacts"
              ? ((manifest.runs as Array<Record<string, unknown>>)[0][field] as Array<Record<string, string>>)[0]
              : ((manifest.runs as Array<Record<string, unknown>>)[0][field] as Record<string, string>)
          artifact.path = replacement
          artifact.sha256 = hash(replacement)
        })
        const result = invoke(f)
        expect(result.exitCode).toBe(6)
        expect(error(result)).toBe(`FAIL ${condition}: ${message}\n`)
      } finally {
        cleanup(f)
      }
    }
  })

  test("maps malformed JUnit content to C7", () => {
    const f = fixture()
    try {
      const junitPath = path.join(f.out, "run-1", "shard-01.xml")
      writeFileSync(junitPath, "<testsuite")
      mutateManifest(f, (manifest) => {
        ;((manifest.runs as Array<Record<string, unknown>>)[0].junit_artifacts as Array<Record<string, unknown>>)[0].sha256 = hash(junitPath)
      })
      const result = invoke(f)
      expect(result.exitCode).toBe(6)
      expect(error(result)).toBe("FAIL C7: JUnit file identity mismatch\n")
      expect(existsSync(f.receipt)).toBe(false)
    } finally {
      cleanup(f)
    }
  })

  test("maps unreadable top-level artifact directories to C10", () => {
    for (const field of ["disk_manifest", "runtime_identity_manifest", "skipped_multiset"] as const) {
      const f = fixture()
      try {
        mutateManifest(f, (manifest) => {
          ;(manifest[field] as Record<string, unknown>).path = f.out
        })
        const result = invoke(f)
        expect(result.exitCode).toBe(7)
        expect(error(result)).toBe(
          `FAIL C10: ${field === "disk_manifest" ? "disk manifest" : field === "runtime_identity_manifest" ? "runtime identity manifest" : "skipped multiset"} hash mismatch\n`,
        )
        expect(existsSync(f.receipt)).toBe(false)
      } finally {
        cleanup(f)
      }
    }
  })

  test("accepts a symlink spelling shared by raw log and manifest artifact_dir", () => {
    const f = fixture()
    try {
      const original = path.join(f.out, "run-1")
      const real = path.join(f.out, "outside-real")
      const link = path.join(f.out, "artifact-link")
      renameSync(original, real)
      symlinkSync(real, link)
      const manifestPath = path.join(f.out, "evidence-manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      const run = (manifest.runs as Array<Record<string, unknown>>)[0]
      run.artifact_dir = link
      for (const field of ["junit_artifacts", "runtime_identity", "skipped_multiset"] as const) {
        const artifacts = Array.isArray(run[field]) ? run[field] : [run[field]]
        for (const artifact of artifacts as Array<Record<string, unknown>>) artifact.path = String(artifact.path).replace(original, link)
      }
      for (const field of ["runtime_identity_manifest", "skipped_multiset"] as const) {
        const aggregate = manifest[field] as Record<string, string>
        const runField = field === "runtime_identity_manifest" ? "runtime_identity" : "skipped_multiset"
        json(aggregate.path, {
          runs: (manifest.runs as Array<Record<string, unknown>>).map((candidate) => ({
            ordinal: candidate.ordinal,
            ...(candidate[runField] as Record<string, unknown>),
          })),
        })
        aggregate.sha256 = hash(aggregate.path)
      }
      json(manifestPath, manifest)
      mutateLog(f, "artifact_dir", link)
      const result = invoke(f)
      expect(error(result)).toBe("")
      expect(result.exitCode).toBe(0)
      expect(readFileSync(f.receipt, "utf8")).toContain('"verdict": "green"')
    } finally {
      cleanup(f)
    }
  })

  test("EV-16 rejects a raw JUnit file identity removed from one shard", () => {
    const f = fixture()
    try {
      writeFileSync(
        path.join(f.out, "run-1", "shard-01.xml"),
        '<testsuites><testcase classname="suite" name="case" file="tests/other.unit.test.ts"/></testsuites>\n',
      )
      expectEv("EV-16", invoke(f))
    } finally {
      cleanup(f)
    }
  })

  test("EV-17 rejects a runnable raw JUnit testcase converted to skipped", () => {
    const f = fixture()
    try {
      const junitPath = path.join(f.out, "run-1", "shard-01.xml")
      writeFileSync(junitPath, '<testsuites><testcase classname="suite" name="case" file="tests/a.unit.test.ts"><skipped/></testcase></testsuites>\n')
      mutateManifest(f, (manifest) => {
        ;((manifest.runs as Array<Record<string, unknown>>)[0].junit_artifacts as Array<Record<string, unknown>>)[0].sha256 = hash(junitPath)
      })
      expectEv("EV-17", invoke(f))
    } finally {
      cleanup(f)
    }
  })
})

afterAll(() => {
  const output = reconcileExecuted(PLAN_MUTATIONS, EXECUTED_MUTATIONS)
  expect(output).toEqual([FROZEN_MUTATION_COUNTS, "mutation ownership: 28 IDs each map to exactly one condition", "duplicate IDs: none", "orphan IDs: none"])
  console.log(output.join("\n"))
})

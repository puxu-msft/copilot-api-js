import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const HANDOVER = "docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md"
const BASELINE = "tests/infra/entry-test-discovery-baseline.json"

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

function fixture(options: { unicodeSkips?: boolean; noncanonicalBaseline?: boolean } = {}) {
  const tree = mkdtempSync(path.join(os.tmpdir(), "entry-validator-"))
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
  for (const script of ["validate-entry-evidence.ts", "entry-evidence-receipt.ts", "entry-evidence-schema.ts", "parallel-test-artifacts.ts"])
    writeFileSync(path.join(tree, "scripts", script), readFileSync(path.join(REPO_ROOT, "scripts", script)))
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
  json(runtimeAggregate, { runs: [] })
  json(skippedAggregate, { runs: [] })
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
  return { tree, out, entry, pointer, receipt: path.join(out, "receipt.json") }
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
  rmSync(f.tree, { recursive: true, force: true })
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
  test("accepts synthetic raw JUnit identities, skips, and logs before C10", () => {
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

  test("EV-02 through EV-13 independently reject pointer and evidence mutations", () => {
    const cases: Array<[string, (text: string, f: ReturnType<typeof fixture>) => string, string]> = [
      ["EV-03", () => "# no pointer\n", "FAIL C2: pointer block missing\n"],
      ["EV-04", (text) => `${text}${text}`, "FAIL C2: pointer block is not unique\n"],
      ["EV-05", (text) => text.replace(/^entry_sha=.*\n/m, ""), "FAIL C3: entry_sha missing\n"],
      ["EV-06", (text) => text.replace(/^manifest_path=.*\n/m, ""), "FAIL C3: manifest path missing\n"],
      ["EV-07", (text) => text.replace(/^manifest_sha256=.*\n/m, ""), "FAIL C3: manifest sha256 missing\n"],
      ["EV-08", (text) => text.replace(/entry_sha=[0-9a-f]{40}/, `entry_sha=${"0".repeat(40)}`), "FAIL C4: pointer entry SHA differs from ENTRY_SHA\n"],
      ["EV-11", (text, f) => text.replace(/manifest_path=.*/, `manifest_path=${path.join(f.out, "missing.json")}`), "FAIL C5: evidence manifest missing\n"],
      ["EV-12", (text) => text.replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${"0".repeat(64)}`), "FAIL C5: evidence manifest hash mismatch\n"],
    ]
    for (const [id, mutate, _expected] of cases) {
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
    const offMaster = fixture()
    try {
      git(offMaster.tree, ["checkout", "--orphan", "side"])
      writeFileSync(path.join(offMaster.tree, "side"), "x\n")
      git(offMaster.tree, ["add", "side"])
      git(offMaster.tree, ["commit", "-m", "side"])
      offMaster.pointer = git(offMaster.tree, ["rev-parse", "HEAD"])
      git(offMaster.tree, ["checkout", "--detach", offMaster.entry])
      expectEv("EV-02", invoke(offMaster))
    } finally {
      cleanup(offMaster)
    }
    const graph = fixture()
    try {
      git(graph.tree, ["checkout", "master"])
      const pointerText = readFileSync(path.join(graph.tree, HANDOVER), "utf8")
      git(graph.tree, ["checkout", "--orphan", "replacement"])
      writeFileSync(path.join(graph.tree, HANDOVER), pointerText)
      git(graph.tree, ["add", HANDOVER])
      git(graph.tree, ["commit", "-m", "unrelated pointer"])
      git(graph.tree, ["branch", "-f", "master", "HEAD"])
      graph.pointer = git(graph.tree, ["rev-parse", "HEAD"])
      git(graph.tree, ["checkout", "--detach", graph.entry])
      expectEv("EV-10", invoke(graph))
    } finally {
      cleanup(graph)
    }
    const head = fixture()
    try {
      git(head.tree, ["checkout", "master"])
      expectEv("EV-09", invoke(head))
    } finally {
      cleanup(head)
    }
    const log = fixture()
    try {
      rmSync(path.join(log.out, "run-1.log"))
      expectEv("EV-13", invoke(log))
    } finally {
      cleanup(log)
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

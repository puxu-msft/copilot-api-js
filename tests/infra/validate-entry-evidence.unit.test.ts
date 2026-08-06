import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const VALIDATOR = path.join(REPO_ROOT, "scripts/validate-entry-evidence.ts")
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

function fixture() {
  const tree = mkdtempSync(path.join(os.tmpdir(), "entry-validator-"))
  const out = mkdtempSync(path.join(os.tmpdir(), "entry-validator-out-"))
  mkdirSync(path.join(tree, path.dirname(HANDOVER)), { recursive: true })
  mkdirSync(path.join(tree, "tests/infra"), { recursive: true })
  mkdirSync(path.join(tree, "tests"), { recursive: true })
  mkdirSync(path.join(tree, "scripts"), { recursive: true })
  writeFileSync(path.join(tree, "tests/a.unit.test.ts"), "")
  writeFileSync(path.join(tree, "scripts/parallel-test.ts"), "export {}\n")
  writeFileSync(path.join(tree, "scripts/validate-entry-evidence.ts"), "export {}\n")
  git(tree, ["init", "-b", "master"])
  git(tree, ["config", "user.email", "x@example.invalid"])
  git(tree, ["config", "user.name", "Test"])
  const runner = git(tree, ["hash-object", "scripts/parallel-test.ts"])
  json(path.join(tree, BASELINE), { schema_version: 1, runner_git_blob: runner, minimum_executed: 1, files: ["tests/a.unit.test.ts"], allowed_skipped: [] })
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
    writeFileSync(junit, '<testsuites><testcase classname="suite" name="case" file="tests/a.unit.test.ts"/></testsuites>\n')
    json(runtime, { files: ["tests/a.unit.test.ts"] })
    json(skipped, { executed: 1, skipped: 0, skipped_identities: [] })
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
      executed: 1,
      skipped: 0,
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
    ["bun", VALIDATOR, "--entry-sha", f.entry, "--pointer-sha", f.pointer, "--tree", f.tree, "--handover", HANDOVER, "--receipt-out", f.receipt],
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

function cleanup(f: ReturnType<typeof fixture>): void {
  rmSync(f.tree, { recursive: true, force: true })
  rmSync(f.out, { recursive: true, force: true })
}

const MUTATIONS = [
  { id: "EV-01", condition: "C1", action: "provide unresolved pointer SHA" },
  { id: "EV-02", condition: "C1", action: "provide non-master-reachable pointer SHA" },
  { id: "EV-03", condition: "C2", action: "remove pointer block" },
  { id: "EV-04", condition: "C2", action: "add second pointer block" },
  { id: "EV-05", condition: "C3", action: "remove entry SHA field" },
  { id: "EV-06", condition: "C3", action: "remove manifest path field" },
  { id: "EV-07", condition: "C3", action: "remove manifest hash field" },
  { id: "EV-08", condition: "C4", action: "change pointer entry SHA" },
  { id: "EV-09", condition: "C4", action: "checkout execution tree to B" },
  { id: "EV-10", condition: "C4", action: "provide pointer excluding A" },
  { id: "EV-11", condition: "C5", action: "remove external manifest" },
  { id: "EV-12", condition: "C5", action: "change pointer manifest hash" },
  { id: "EV-13", condition: "C6", action: "remove listed run log" },
  { id: "EV-14", condition: "C6", action: "add sixteenth run log entry" },
  { id: "EV-15", condition: "C6", action: "mutate raw run log byte" },
  { id: "EV-16", condition: "C7", action: "remove raw JUnit file identity" },
  { id: "EV-17", condition: "C8", action: "mark runnable JUnit testcase skipped" },
  { id: "EV-18", condition: "C9", action: "change raw canonical command" },
  { id: "EV-19", condition: "C9", action: "change raw evidence timing" },
  { id: "EV-20", condition: "C9", action: "change raw measured SHA" },
  { id: "EV-21", condition: "C9", action: "change raw current-head claim" },
  { id: "EV-22", condition: "C9", action: "change raw verdict" },
  { id: "EV-23", condition: "C10", action: "mutate disk manifest bytes" },
  { id: "EV-24", condition: "C10", action: "mutate runtime identity manifest bytes" },
  { id: "EV-25", condition: "C10", action: "mutate skipped multiset bytes" },
  { id: "EV-26", condition: "C11", action: "change discovery baseline path" },
  { id: "EV-27", condition: "C11", action: "change discovery baseline hash" },
  { id: "EV-28", condition: "C11", action: "change discovery runner blob" },
] as const

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

  test("mechanically reconciles the frozen mutation table", () => {
    const coverage = new Map<string, number>()
    const ids = new Set<string>()
    for (const mutation of MUTATIONS) {
      coverage.set(mutation.condition, (coverage.get(mutation.condition) ?? 0) + 1)
      expect(ids.has(mutation.id)).toBe(false)
      ids.add(mutation.id)
      expect(mutation.action).not.toMatch(/／|分别|之一|任一/)
    }
    const output = [
      `condition coverage: ${["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11"].map((condition) => `${condition}=${coverage.get(condition) ?? 0}`).join(" ")}`,
      `mutation ownership: ${ids.size} IDs each map to exactly one condition`,
      "duplicate IDs: none",
      "orphan IDs: none",
    ]
    expect(output).toEqual([
      "condition coverage: C1=2 C2=2 C3=3 C4=3 C5=2 C6=3 C7=1 C8=1 C9=5 C10=3 C11=3",
      "mutation ownership: 28 IDs each map to exactly one condition",
      "duplicate IDs: none",
      "orphan IDs: none",
    ])
  })

  test("EV-01 rejects an unresolved POINTER_SHA", () => {
    const f = fixture()
    try {
      f.pointer = "0".repeat(40)
      expect(error(invoke(f))).toBe("FAIL C1: pointer SHA does not resolve\n")
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
      expect(error(invoke(countFixture))).toBe("FAIL C6: run log count is not 15\n")
    } finally {
      cleanup(countFixture)
    }
    const hashFixture = fixture()
    try {
      writeFileSync(path.join(hashFixture.out, "run-1.log"), "tampered\n")
      expect(error(invoke(hashFixture))).toBe("FAIL C6: run log hash mismatch\n")
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
    for (const [_id, mutate, expected] of cases) {
      const f = fixture()
      try {
        git(f.tree, ["checkout", "master"])
        const pointerPath = path.join(f.tree, HANDOVER)
        writeFileSync(pointerPath, mutate(readFileSync(pointerPath, "utf8"), f))
        git(f.tree, ["add", HANDOVER])
        git(f.tree, ["commit", "-m", "mutation"])
        f.pointer = git(f.tree, ["rev-parse", "HEAD"])
        git(f.tree, ["checkout", "--detach", f.entry])
        expect(error(invoke(f))).toBe(expected)
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
      expect(error(invoke(offMaster))).toBe("FAIL C1: pointer SHA is not master-reachable\n")
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
      expect(error(invoke(graph))).toBe("FAIL C4: ENTRY_SHA is not an ancestor of POINTER_SHA\n")
    } finally {
      cleanup(graph)
    }
    const head = fixture()
    try {
      git(head.tree, ["checkout", "master"])
      expect(error(invoke(head))).toBe("FAIL C4: execution HEAD differs from ENTRY_SHA\n")
    } finally {
      cleanup(head)
    }
    const log = fixture()
    try {
      rmSync(path.join(log.out, "run-1.log"))
      expect(error(invoke(log))).toBe("FAIL C6: run log missing\n")
    } finally {
      cleanup(log)
    }
  })

  test("EV-18 through EV-22 reject one independently refreshed raw log field", () => {
    for (const [field, value, expected] of [
      ["canonical_command", "bun scripts/parallel-test.ts unit", "FAIL C9: canonical command mismatch\n"],
      ["evidence_timing", "before-closeout", "FAIL C9: evidence timing mismatch\n"],
      ["measured_sha", "0".repeat(40), "FAIL C9: measured SHA mismatch\n"],
      ["claims_current_head", "false", "FAIL C9: current-head claim mismatch\n"],
      ["verdict", "red", "FAIL C9: run verdict is not green\n"],
    ]) {
      const f = fixture()
      try {
        mutateLog(f, field, value)
        expect(error(invoke(f))).toBe(expected)
      } finally {
        cleanup(f)
      }
    }
  })

  test("EV-23 through EV-25 reject each independently mutated top-level artifact", () => {
    for (const [field, expected] of [
      ["disk_manifest", "FAIL C10: disk manifest hash mismatch\n"],
      ["runtime_identity_manifest", "FAIL C10: runtime identity manifest hash mismatch\n"],
      ["skipped_multiset", "FAIL C10: skipped multiset hash mismatch\n"],
    ] as const) {
      const f = fixture()
      try {
        mutateTopLevelArtifact(f, field)
        expect(error(invoke(f))).toBe(expected)
      } finally {
        cleanup(f)
      }
    }
  })

  test("EV-26 through EV-28 reject one manifest baseline binding", () => {
    for (const [mutate, expected] of [
      [
        (manifest: Record<string, unknown>) => (manifest.discovery_baseline_path = "tests/infra/other.json"),
        "FAIL C11: discovery baseline path differs from entry\n",
      ],
      [(manifest: Record<string, unknown>) => (manifest.discovery_baseline_sha256 = "0".repeat(64)), "FAIL C11: discovery baseline hash mismatch\n"],
      [(manifest: Record<string, unknown>) => (manifest.discovery_runner_git_blob = "0".repeat(40)), "FAIL C11: discovery runner blob mismatch\n"],
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
      expect(error(invoke(f))).toBe("FAIL C7: JUnit file identity mismatch\n")
    } finally {
      cleanup(f)
    }
  })

  test("EV-17 rejects a runnable raw JUnit testcase converted to skipped", () => {
    const f = fixture()
    try {
      writeFileSync(
        path.join(f.out, "run-1", "shard-01.xml"),
        '<testsuites><testcase classname="suite" name="case" file="tests/a.unit.test.ts"><skipped/></testcase></testsuites>\n',
      )
      expect(error(invoke(f))).toBe("FAIL C8: skipped identity multiset mismatch\n")
    } finally {
      cleanup(f)
    }
  })
})

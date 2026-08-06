import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeReceiptAtomically } from "../../scripts/entry-evidence-receipt"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const VALIDATOR = path.join(REPO_ROOT, "scripts/validate-entry-evidence.ts")
const HANDOVER = "docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md"

interface Fixture {
  tree: string
  out: string
  entrySha: string
  pointerSha: string
  manifestPath: string
}

function git(tree: string, args: Array<string>): string {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}
function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function createFixture(): Fixture {
  const tree = mkdtempSync(path.join(os.tmpdir(), "validate-entry-evidence-"))
  const out = mkdtempSync(path.join(os.tmpdir(), "validate-entry-evidence-out-"))
  mkdirSync(path.join(tree, path.dirname(HANDOVER)), { recursive: true })
  writeFileSync(path.join(tree, HANDOVER), "# handover\n")
  git(tree, ["init", "-b", "master"])
  git(tree, ["config", "user.email", "test@example.invalid"])
  git(tree, ["config", "user.name", "Test"])
  git(tree, ["add", "."])
  git(tree, ["commit", "-m", "entry"])
  const entrySha = git(tree, ["rev-parse", "HEAD"])
  const runs = Array.from({ length: 15 }, (_, index) => {
    const ordinal = index + 1
    const log_path = path.join(out, `run-${String(ordinal).padStart(2, "0")}.log`)
    writeFileSync(log_path, `run=${ordinal}\n`)
    return {
      ordinal,
      log_path,
      log_sha256: sha256(log_path),
      artifact_dir: path.join(out, `run-${ordinal}`),
      junit_artifacts: [],
      runtime_identity: { path: path.join(out, "runtime"), sha256: "0".repeat(64) },
      skipped_multiset: { path: path.join(out, "skipped"), sha256: "0".repeat(64) },
      executed: 0,
      skipped: 0,
      verdict: "green",
    }
  })
  const manifestPath = path.join(out, "evidence-manifest.json")
  writeJson(manifestPath, {
    schema_version: 1,
    measured_sha: entrySha,
    evidence_timing: "closeout",
    claims_current_head: true,
    out_dir: out,
    canonical_command: "bun scripts/parallel-test.ts unit it http",
    discovery_baseline_path: "tests/infra/entry-test-discovery-baseline.json",
    discovery_baseline_sha256: "0".repeat(64),
    discovery_runner_git_blob: "0".repeat(40),
    disk_manifest: { path: path.join(out, "disk"), sha256: "0".repeat(64) },
    runtime_identity_manifest: { path: path.join(out, "runtime-manifest"), sha256: "0".repeat(64) },
    skipped_multiset: { path: path.join(out, "skipped-manifest"), sha256: "0".repeat(64) },
    runs,
  })
  writeFileSync(
    path.join(tree, HANDOVER),
    `<!-- entry-evidence-pointer:v1 -->\nentry_sha=${entrySha}\nmanifest_path=${manifestPath}\nmanifest_sha256=${sha256(manifestPath)}\narchive_path=\n<!-- /entry-evidence-pointer:v1 -->\n`,
  )
  git(tree, ["add", HANDOVER])
  git(tree, ["commit", "-m", "pointer"])
  const pointerSha = git(tree, ["rev-parse", "HEAD"])
  git(tree, ["checkout", "--detach", entrySha])
  return { tree, out, entrySha, pointerSha, manifestPath }
}
function run(fixture: Fixture, pointerSha = fixture.pointerSha, tree = fixture.tree): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      "bun",
      VALIDATOR,
      "--entry-sha",
      fixture.entrySha,
      "--pointer-sha",
      pointerSha,
      "--tree",
      tree,
      "--handover",
      HANDOVER,
      "--receipt-out",
      path.join(fixture.out, "receipt.json"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
}
function stderr(result: ReturnType<typeof Bun.spawnSync>): string {
  return new TextDecoder().decode(result.stderr).replaceAll(/\x1b\[[0-9;]*m/g, "")
}
function amendPointer(fixture: Fixture, transform: (text: string) => string): string {
  git(fixture.tree, ["checkout", "-B", "master", fixture.pointerSha])
  const pointer = path.join(fixture.tree, HANDOVER)
  writeFileSync(pointer, transform(readFileSync(pointer, "utf8")))
  git(fixture.tree, ["add", HANDOVER])
  git(fixture.tree, ["commit", "-m", "mutation"])
  const sha = git(fixture.tree, ["rev-parse", "HEAD"])
  git(fixture.tree, ["checkout", "--detach", fixture.entrySha])
  return sha
}
function expectFail(fixture: Fixture, expected: string, pointerSha = fixture.pointerSha, tree = fixture.tree): void {
  expect(stderr(run(fixture, pointerSha, tree))).toBe(expected)
}
function clean(fixture: Fixture): void {
  rmSync(fixture.tree, { recursive: true, force: true })
  rmSync(fixture.out, { recursive: true, force: true })
}

describe("validate-entry-evidence C1-C6", () => {
  test("positive C1-C6 fixture reaches explicit C7 checkpoint", () => {
    const fixture = createFixture()
    try {
      expectFail(fixture, "FAIL C7: JUnit identity validation is not implemented in this checkpoint\n")
    } finally {
      clean(fixture)
    }
  })
  test("EV-01 through EV-13 produce unique frozen failures", () => {
    const fixture = createFixture()
    try {
      git(fixture.tree, ["checkout", "--orphan", "side"])
      writeFileSync(path.join(fixture.tree, "side.txt"), "side\n")
      git(fixture.tree, ["add", "side.txt"])
      git(fixture.tree, ["commit", "-m", "side"])
      const sideSha = git(fixture.tree, ["rev-parse", "HEAD"])
      git(fixture.tree, ["checkout", "--detach", fixture.entrySha])
      expectFail(fixture, "FAIL C1: pointer SHA is not master-reachable\n", sideSha)
      expectFail(
        fixture,
        "FAIL C2: pointer block missing\n",
        amendPointer(fixture, () => "# none\n"),
      )
      expectFail(
        fixture,
        "FAIL C2: pointer block is not unique\n",
        amendPointer(fixture, (text) => `${text}${text}`),
      )
      expectFail(
        fixture,
        "FAIL C3: entry_sha missing\n",
        amendPointer(fixture, (text) => text.replace(/^entry_sha=.*\n/m, "")),
      )
      expectFail(
        fixture,
        "FAIL C3: manifest path missing\n",
        amendPointer(fixture, (text) => text.replace(/^manifest_path=.*\n/m, "")),
      )
      expectFail(
        fixture,
        "FAIL C3: manifest sha256 missing\n",
        amendPointer(fixture, (text) => text.replace(/^manifest_sha256=.*\n/m, "")),
      )
      expectFail(
        fixture,
        "FAIL C4: pointer entry SHA differs from ENTRY_SHA\n",
        amendPointer(fixture, (text) => text.replace(/entry_sha=[0-9a-f]{40}/, `entry_sha=${"b".repeat(40)}`)),
      )
      git(fixture.tree, ["checkout", "master"])
      expectFail(fixture, "FAIL C4: execution HEAD differs from ENTRY_SHA\n")
      git(fixture.tree, ["checkout", "--detach", fixture.entrySha])
      expectFail(
        fixture,
        "FAIL C5: evidence manifest missing\n",
        amendPointer(fixture, (text) => text.replace(/manifest_path=.*/, `manifest_path=${path.join(fixture.out, "missing")}`)),
      )
      expectFail(
        fixture,
        "FAIL C5: evidence manifest hash mismatch\n",
        amendPointer(fixture, (text) => text.replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${"0".repeat(64)}`)),
      )
      rmSync(path.join(fixture.out, "run-01.log"))
      expectFail(fixture, "FAIL C6: run log missing\n")
    } finally {
      clean(fixture)
    }
  })
  test("rejects duplicate log paths and accepts a permuted manifest key set", () => {
    const fixture = createFixture()
    try {
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"))
      manifest.runs[1].log_path = manifest.runs[0].log_path
      manifest.runs[1].log_sha256 = manifest.runs[0].log_sha256
      const permuted = Object.fromEntries(Object.entries(manifest).reverse())
      permuted.runs = manifest.runs.map((run: Record<string, unknown>) => Object.fromEntries(Object.entries(run).reverse()))
      writeJson(fixture.manifestPath, permuted)
      const pointerSha = amendPointer(fixture, (text) => text.replace(/manifest_sha256=[0-9a-f]{64}/, `manifest_sha256=${sha256(fixture.manifestPath)}`))
      expectFail(fixture, "FAIL C6: run log paths are not unique\n", pointerSha)
    } finally {
      clean(fixture)
    }
  })

  test("rejects a non-frozen handover and tree-contained pointer paths", () => {
    const fixture = createFixture()
    try {
      const nonFrozen = Bun.spawnSync(
        [
          "bun",
          VALIDATOR,
          "--entry-sha",
          fixture.entrySha,
          "--pointer-sha",
          fixture.pointerSha,
          "--tree",
          fixture.tree,
          "--handover",
          "docs/other.md",
          "--receipt-out",
          path.join(fixture.out, "receipt.json"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(nonFrozen.exitCode).toBe(2)
      const treeManifest = path.join(fixture.tree, "manifest.json")
      writeFileSync(treeManifest, "{}\n")
      expectFail(
        fixture,
        "FAIL C5: evidence manifest must be outside TREE\n",
        amendPointer(fixture, (text) => text.replace(/manifest_path=.*/, `manifest_path=${treeManifest}`)),
      )
      const linked = path.join(fixture.out, "tree-link")
      symlinkSync(fixture.tree, linked)
      expectFail(
        fixture,
        "FAIL C5: evidence manifest must be outside TREE\n",
        amendPointer(fixture, (text) => text.replace(/manifest_path=.*/, `manifest_path=${path.join(linked, "manifest.json")}`)),
      )
    } finally {
      clean(fixture)
    }
  })

  test("receipt writer preserves existing temp and regular receipt targets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "receipt-"))
    const receipt = path.join(root, "receipt.json")
    const existingTemp = path.join(root, ".receipt.json.foreign.tmp")
    writeFileSync(receipt, "old receipt\n")
    writeFileSync(existingTemp, "foreign temp\n")
    try {
      expect(() => writeReceiptAtomically(receipt, "new\n")).toThrow()
      expect(readFileSync(receipt, "utf8")).toBe("old receipt\n")
      expect(readFileSync(existingTemp, "utf8")).toBe("foreign temp\n")
      expect(existsSync(path.join(root, ".receipt.json.tmp"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

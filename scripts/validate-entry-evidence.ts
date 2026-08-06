#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

interface Options {
  entrySha: string
  pointerSha: string
  tree: string
  handover: string
  receiptOut: string
}

interface RunLog {
  ordinal: number
  log_path: string
  log_sha256: string
}

const POINTER_BEGIN = "<!-- entry-evidence-pointer:v1 -->"
const POINTER_END = "<!-- /entry-evidence-pointer:v1 -->"
const MANIFEST_KEYS = [
  "schema_version",
  "measured_sha",
  "evidence_timing",
  "claims_current_head",
  "out_dir",
  "canonical_command",
  "discovery_baseline_path",
  "discovery_baseline_sha256",
  "discovery_runner_git_blob",
  "disk_manifest",
  "runtime_identity_manifest",
  "skipped_multiset",
  "runs",
]
const RUN_KEYS = [
  "ordinal",
  "log_path",
  "log_sha256",
  "artifact_dir",
  "junit_artifacts",
  "runtime_identity",
  "skipped_multiset",
  "executed",
  "skipped",
  "verdict",
]

function fail(condition: number, message: string, exitCode: number): never {
  console.error(`FAIL C${condition}: ${message}`)
  process.exit(exitCode)
}

function cliFail(): never {
  process.exit(2)
}

function isSha(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function exactKeys(value: Record<string, unknown>, keys: Array<string>): boolean {
  return Object.keys(value).join("\0") === keys.join("\0")
}

function parseOptions(argv: Array<string>): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) cliFail()
    values.set(flag, value)
  }
  const expected = ["--entry-sha", "--pointer-sha", "--tree", "--handover", "--receipt-out"]
  if (values.size !== expected.length || [...values.keys()].some((flag) => !expected.includes(flag))) cliFail()
  const entrySha = values.get("--entry-sha")!
  const pointerSha = values.get("--pointer-sha")!
  const tree = values.get("--tree")!
  const handover = values.get("--handover")!
  const receiptOut = values.get("--receipt-out")!
  if (!isSha(entrySha, 40) || !isSha(pointerSha, 40) || !path.isAbsolute(tree) || !path.isAbsolute(receiptOut) || path.isAbsolute(handover)) cliFail()
  return { entrySha, pointerSha, tree, handover, receiptOut }
}

function git(tree: string, args: Array<string>): string | undefined {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

function parsePointer(raw: string): { entrySha: string; manifestPath: string; manifestSha: string } {
  const starts = raw.split(POINTER_BEGIN).length - 1
  const ends = raw.split(POINTER_END).length - 1
  if (starts === 0 || ends === 0) fail(2, "pointer block missing", 3)
  if (starts !== 1 || ends !== 1) fail(2, "pointer block is not unique", 3)
  const body = raw.slice(raw.indexOf(POINTER_BEGIN) + POINTER_BEGIN.length, raw.indexOf(POINTER_END)).trim()
  const fields = new Map<string, string>()
  for (const line of body.split("\n")) {
    const index = line.indexOf("=")
    if (index <= 0 || fields.has(line.slice(0, index))) cliFail()
    fields.set(line.slice(0, index), line.slice(index + 1))
  }
  const entrySha = fields.get("entry_sha")
  const manifestPath = fields.get("manifest_path")
  const manifestSha = fields.get("manifest_sha256")
  if (!entrySha) fail(3, "entry_sha missing", 3)
  if (!manifestPath) fail(3, "manifest path missing", 3)
  if (!manifestSha) fail(3, "manifest sha256 missing", 3)
  if (!isSha(entrySha, 40) || !path.isAbsolute(manifestPath) || !isSha(manifestSha, 64) || fields.get("archive_path") === undefined || fields.size !== 4)
    cliFail()
  return { entrySha, manifestPath, manifestSha }
}

function parseManifest(raw: string): Array<RunLog> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    cliFail()
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, MANIFEST_KEYS)) cliFail()
  const manifest = value as Record<string, unknown>
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.runs)) cliFail()
  return manifest.runs.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !exactKeys(candidate as Record<string, unknown>, RUN_KEYS)) cliFail()
    const run = candidate as Record<string, unknown>
    if (!Number.isSafeInteger(run.ordinal) || typeof run.log_path !== "string" || !path.isAbsolute(run.log_path) || !isSha(run.log_sha256, 64)) cliFail()
    return { ordinal: run.ordinal as number, log_path: run.log_path, log_sha256: run.log_sha256 }
  })
}

const options = parseOptions(process.argv.slice(2))

if (!existsSync(options.tree) || git(options.tree, ["cat-file", "-e", `${options.pointerSha}^{commit}`]) === undefined)
  fail(1, "pointer SHA does not resolve", 3)
if (git(options.tree, ["merge-base", "--is-ancestor", options.pointerSha, "master"]) === undefined) fail(1, "pointer SHA is not master-reachable", 3)
const handover = git(options.tree, ["show", `${options.pointerSha}:${options.handover}`])
if (handover === undefined) fail(1, "pointer SHA does not resolve", 3)
const pointer = parsePointer(handover)
if (pointer.entrySha !== options.entrySha) fail(4, "pointer entry SHA differs from ENTRY_SHA", 3)
if (git(options.tree, ["rev-parse", "HEAD"]) !== options.entrySha) fail(4, "execution HEAD differs from ENTRY_SHA", 3)
if (git(options.tree, ["merge-base", "--is-ancestor", options.entrySha, options.pointerSha]) === undefined)
  fail(4, "ENTRY_SHA is not an ancestor of POINTER_SHA", 3)
if (!existsSync(pointer.manifestPath)) fail(5, "evidence manifest missing", 4)
if (sha256(pointer.manifestPath) !== pointer.manifestSha) fail(5, "evidence manifest hash mismatch", 4)
const runs = parseManifest(readFileSync(pointer.manifestPath, "utf8"))
if (
  runs.length !== 15 ||
  !runs
    .map((run) => run.ordinal)
    .sort((left, right) => left - right)
    .every((ordinal, index) => ordinal === index + 1)
)
  fail(6, "run log count is not 15", 5)
for (const run of runs) {
  if (!existsSync(run.log_path)) fail(6, "run log missing", 5)
  if (sha256(run.log_path) !== run.log_sha256) fail(6, "run log hash mismatch", 5)
}

// C7-C11 remain deliberately unavailable in this checkpoint. The receipt writer is versioned separately but is not callable until every condition is implemented.
fail(7, "JUnit identity validation is not implemented in this checkpoint", 6)

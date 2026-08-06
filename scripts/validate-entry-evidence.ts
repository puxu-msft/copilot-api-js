#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"

import { writeReceiptAtomically } from "./entry-evidence-receipt"
import { parseDiscoveryBaseline } from "./entry-evidence-schema"
import { parseJUnit } from "./parallel-test-artifacts"

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

const HANDOVER_PATH = "docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md"
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
function logField(log: string, name: string): string | undefined {
  return new RegExp(`^${name}=([^\\n]+)$`, "m").exec(log)?.[1]
}
function identityKey(identity: Record<string, unknown>): string | undefined {
  if (
    identity.kind === "testcase" &&
    typeof identity.file === "string" &&
    typeof identity.classname === "string" &&
    typeof identity.name === "string" &&
    Number.isSafeInteger(identity.ordinal) &&
    Number.isSafeInteger(identity.count)
  )
    return ["testcase", identity.file, identity.classname, identity.name, identity.ordinal, identity.count].join("\0")
  if (identity.kind === "suite" && typeof identity.file === "string" && typeof identity.suite_name === "string" && Number.isSafeInteger(identity.count))
    return ["suite", identity.file, identity.suite_name, identity.count].join("\0")
  return undefined
}
function identityMultiset(identities: unknown[]): string[] | undefined {
  const keys = identities.map((identity) =>
    identity && typeof identity === "object" && !Array.isArray(identity) ? identityKey(identity as Record<string, unknown>) : undefined,
  )
  return keys.some((key) => key === undefined) ? undefined : (keys as string[]).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
}
function exactKeys(value: Record<string, unknown>, keys: Array<string>): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
function git(tree: string, args: Array<string>): string | undefined {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}
function gitBytes(tree: string, args: Array<string>): Uint8Array | undefined {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? new Uint8Array(result.stdout) : undefined
}
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}
function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate)
  const suffix: Array<string> = []
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return absolute
    suffix.unshift(path.basename(existing))
    existing = parent
  }
  return path.join(realpathSync(existing), ...suffix)
}

function canonicalInside(candidate: string, tree: string): boolean {
  const resolved = canonicalPath(candidate)
  const relative = path.relative(realpathSync(tree), resolved)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
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
  if (!isSha(entrySha, 40) || !isSha(pointerSha, 40) || !path.isAbsolute(tree) || !path.isAbsolute(receiptOut) || handover !== HANDOVER_PATH) cliFail()
  return { entrySha, pointerSha, tree, handover, receiptOut }
}

function parsePointer(raw: string): { entrySha: string; manifestPath: string; manifestSha: string } {
  const starts = raw.split(POINTER_BEGIN).length - 1
  const ends = raw.split(POINTER_END).length - 1
  if (starts === 0 || ends === 0) fail(2, "pointer block missing", 3)
  if (starts !== 1 || ends !== 1) fail(2, "pointer block is not unique", 3)
  const fields = new Map<string, string>()
  for (const line of raw
    .slice(raw.indexOf(POINTER_BEGIN) + POINTER_BEGIN.length, raw.indexOf(POINTER_END))
    .trim()
    .split("\n")) {
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
  if (manifest.schema_version !== 1) cliFail()
  const runs = manifest.runs
  if (!Array.isArray(runs)) cliFail()
  return runs.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !exactKeys(candidate as Record<string, unknown>, RUN_KEYS)) cliFail()
    const run = candidate as Record<string, unknown>
    if (!Number.isSafeInteger(run.ordinal) || typeof run.log_path !== "string" || !path.isAbsolute(run.log_path) || !isSha(run.log_sha256, 64)) cliFail()
    return { ordinal: run.ordinal as number, log_path: run.log_path, log_sha256: run.log_sha256 }
  })
}

function artifactUnder(child: string, parent: string): boolean {
  const relative = path.relative(realpathSync(parent), realpathSync(child))
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function parseRunArtifacts(
  run: Record<string, unknown>,
  tree: string,
): {
  junit: Array<{ path: string; sha256: string }>
  runtime: { path: string; sha256: string }
  skipped: { path: string; sha256: string }
  artifactDir: string
} {
  const artifactDir = run.artifact_dir
  const junit = run.junit_artifacts
  const runtime = run.runtime_identity
  const skipped = run.skipped_multiset
  if (
    typeof artifactDir !== "string" ||
    !path.isAbsolute(artifactDir) ||
    canonicalInside(artifactDir, tree) ||
    !Array.isArray(junit) ||
    junit.length === 0 ||
    !runtime ||
    !skipped
  )
    fail(7, "JUnit file identity mismatch", 6)
  const asArtifact = (value: unknown): { path: string; sha256: string } | undefined => {
    if (!value || typeof value !== "object" || !exactKeys(value as Record<string, unknown>, ["path", "sha256"])) return undefined
    const artifact = value as Record<string, unknown>
    return typeof artifact.path === "string" && typeof artifact.sha256 === "string" && isSha(artifact.sha256, 64)
      ? { path: artifact.path, sha256: artifact.sha256 }
      : undefined
  }
  const junitArtifacts = junit.map(asArtifact)
  const runtimeArtifact = asArtifact(runtime)
  const skippedArtifact = asArtifact(skipped)
  if (junitArtifacts.some((artifact) => !artifact) || !runtimeArtifact || !skippedArtifact) fail(7, "JUnit file identity mismatch", 6)
  const resolvedJunit = junitArtifacts as Array<{ path: string; sha256: string }>
  const paths = resolvedJunit.map((artifact) => artifact.path)
  const names = paths.map((file) => path.basename(file))
  if (
    new Set(paths).size !== paths.length ||
    names.some((name, index) => index > 0 && Buffer.from(names[index - 1]).compare(Buffer.from(name)) >= 0) ||
    resolvedJunit.some((artifact) => !artifactUnder(artifact.path, artifactDir) || !existsSync(artifact.path) || sha256(artifact.path) !== artifact.sha256) ||
    !artifactUnder(runtimeArtifact.path, artifactDir) ||
    !artifactUnder(skippedArtifact.path, artifactDir) ||
    !existsSync(runtimeArtifact.path) ||
    !existsSync(skippedArtifact.path) ||
    sha256(runtimeArtifact.path) !== runtimeArtifact.sha256 ||
    sha256(skippedArtifact.path) !== skippedArtifact.sha256
  )
    fail(7, "JUnit file identity mismatch", 6)
  const actualJunit = readdirSync(artifactDir)
    .filter((name) => /^shard-\d+\.xml$/.test(name))
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (JSON.stringify(actualJunit) !== JSON.stringify(names)) fail(7, "JUnit file identity mismatch", 6)
  return { junit: resolvedJunit, runtime: runtimeArtifact, skipped: skippedArtifact, artifactDir }
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
if (canonicalInside(pointer.manifestPath, options.tree)) fail(5, "evidence manifest must be outside TREE", 4)
if (!existsSync(pointer.manifestPath)) fail(5, "evidence manifest missing", 4)
if (sha256(pointer.manifestPath) !== pointer.manifestSha) fail(5, "evidence manifest hash mismatch", 4)
if (canonicalInside(options.receiptOut, options.tree)) cliFail()
const runs = parseManifest(readFileSync(pointer.manifestPath, "utf8"))
if (
  runs.length !== 15 ||
  !runs
    .map((run) => run.ordinal)
    .sort((left, right) => left - right)
    .every((ordinal, index) => ordinal === index + 1)
)
  fail(6, "run log count is not 15", 5)
const canonicalLogPaths: Array<string> = []
for (const run of runs) {
  if (!existsSync(run.log_path)) fail(6, "run log missing", 5)
  const canonicalLogPath = realpathSync(run.log_path)
  canonicalLogPaths.push(canonicalLogPath)
  if (sha256(canonicalLogPath) !== run.log_sha256) fail(6, "run log hash mismatch", 5)
}
if (new Set(canonicalLogPaths).size !== runs.length) fail(6, "run log paths are not unique", 5)

const manifest = JSON.parse(readFileSync(pointer.manifestPath, "utf8")) as Record<string, unknown>
if (typeof manifest.canonical_command !== "string" || manifest.canonical_command !== "bun scripts/parallel-test.ts unit it http")
  fail(9, "canonical command mismatch", 7)
if (typeof manifest.evidence_timing !== "string" || manifest.evidence_timing !== "closeout") fail(9, "evidence timing mismatch", 7)
if (typeof manifest.measured_sha !== "string" || manifest.measured_sha !== options.entrySha) fail(9, "measured SHA mismatch", 7)
if (typeof manifest.claims_current_head !== "boolean" || manifest.claims_current_head !== true) fail(9, "current-head claim mismatch", 7)
const baselineBytes = gitBytes(options.tree, ["show", `${options.entrySha}:tests/infra/entry-test-discovery-baseline.json`])
const baselineRaw = baselineBytes === undefined ? undefined : decodeUtf8(baselineBytes)
if (baselineRaw === undefined) fail(11, "discovery baseline hash mismatch", 7)
let baseline
try {
  baseline = parseDiscoveryBaseline(baselineRaw)
} catch {
  fail(11, "discovery baseline hash mismatch", 7)
}
if (createHash("sha256").update(baselineBytes!).digest("hex") !== manifest.discovery_baseline_sha256) fail(11, "discovery baseline hash mismatch", 7)
for (const run of manifest.runs as Array<Record<string, unknown>>) {
  if (!exactKeys(run, RUN_KEYS)) fail(7, "JUnit file identity mismatch", 6)
  const log = readFileSync(run.log_path as string, "utf8")
  if (typeof run.artifact_dir !== "string" || !existsSync(run.artifact_dir) || logField(log, "artifact_dir") !== realpathSync(run.artifact_dir))
    fail(9, "artifact directory mismatch", 7)
  const artifacts = parseRunArtifacts(run, options.tree)
  const junit = artifacts.junit.map((artifact) => parseJUnit(readFileSync(artifact.path, "utf8"), options.tree))
  const files = [...new Set(junit.flatMap((item) => item.files))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (JSON.stringify(files) !== JSON.stringify(baseline.files)) fail(7, "JUnit file identity mismatch", 6)
  let runtime: unknown
  let skipped: unknown
  try {
    runtime = JSON.parse(readFileSync(artifacts.runtime.path, "utf8"))
    skipped = JSON.parse(readFileSync(artifacts.skipped.path, "utf8"))
  } catch {
    fail(8, "skipped identity multiset mismatch", 6)
  }
  if (
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    !exactKeys(runtime as Record<string, unknown>, ["files"]) ||
    !Array.isArray((runtime as Record<string, unknown>).files) ||
    !((runtime as Record<string, unknown>).files as unknown[]).every((file) => typeof file === "string") ||
    JSON.stringify((runtime as { files: string[] }).files) !== JSON.stringify(files)
  )
    fail(7, "JUnit file identity mismatch", 6)
  if (
    !skipped ||
    typeof skipped !== "object" ||
    Array.isArray(skipped) ||
    !exactKeys(skipped as Record<string, unknown>, ["executed", "skipped", "skipped_identities"]) ||
    !Number.isSafeInteger((skipped as Record<string, unknown>).executed) ||
    !Number.isSafeInteger((skipped as Record<string, unknown>).skipped) ||
    !Array.isArray((skipped as Record<string, unknown>).skipped_identities)
  )
    fail(8, "skipped identity multiset mismatch", 6)
  const skippedValue = skipped as { executed: number; skipped: number; skipped_identities: unknown[] }
  const actualExecuted = junit.reduce((sum, item) => sum + item.executed, 0)
  const actualSkipped = junit.reduce((sum, item) => sum + item.skipped, 0)
  const actualIdentities = junit.flatMap((item) => item.skippedIdentities)
  const expectedIdentities = baseline.allowed_skipped.map(({ reason: _reason, ...identity }) => identity)
  if (
    actualExecuted !== skippedValue.executed ||
    actualSkipped !== skippedValue.skipped ||
    actualExecuted !== run.executed ||
    actualSkipped !== run.skipped ||
    identityMultiset(actualIdentities) === undefined ||
    JSON.stringify(identityMultiset(actualIdentities)) !== JSON.stringify(identityMultiset(skippedValue.skipped_identities)) ||
    JSON.stringify(identityMultiset(actualIdentities)) !== JSON.stringify(identityMultiset(expectedIdentities)) ||
    actualExecuted < baseline.minimum_executed
  )
    fail(8, "skipped identity multiset mismatch", 6)
  if (logField(log, "canonical_command") !== manifest.canonical_command) fail(9, "canonical command mismatch", 7)
  if (logField(log, "evidence_timing") !== manifest.evidence_timing) fail(9, "evidence timing mismatch", 7)
  if (logField(log, "measured_sha") !== manifest.measured_sha) fail(9, "measured SHA mismatch", 7)
  if (logField(log, "claims_current_head") !== String(manifest.claims_current_head)) fail(9, "current-head claim mismatch", 7)
  if (typeof run.verdict !== "string" || run.verdict !== "green" || logField(log, "verdict") !== run.verdict) fail(9, "run verdict is not green", 7)
}
for (const [label, artifact] of [
  ["disk manifest", manifest.disk_manifest],
  ["runtime identity manifest", manifest.runtime_identity_manifest],
  ["skipped multiset", manifest.skipped_multiset],
] as Array<[string, unknown]>) {
  if (
    !artifact ||
    typeof artifact !== "object" ||
    typeof (artifact as { path?: unknown }).path !== "string" ||
    typeof (artifact as { sha256?: unknown }).sha256 !== "string"
  )
    fail(10, `${label} hash mismatch`, 7)
  const { path: artifactPath, sha256: artifactHash } = artifact as { path: string; sha256: string }
  if (!artifactPath || !artifactHash || !existsSync(artifactPath) || sha256(artifactPath) !== artifactHash) fail(10, `${label} hash mismatch`, 7)
}
const entryBaselinePath = "tests/infra/entry-test-discovery-baseline.json"
if (manifest.discovery_baseline_path !== entryBaselinePath) fail(11, "discovery baseline path differs from entry", 7)
const runnerBlob = git(options.tree, ["rev-parse", `${options.entrySha}:scripts/parallel-test.ts`])
if (runnerBlob === undefined) fail(11, "discovery baseline hash mismatch", 7)
if (createHash("sha256").update(baselineBytes!).digest("hex") !== manifest.discovery_baseline_sha256) fail(11, "discovery baseline hash mismatch", 7)
if (baseline.runner_git_blob !== runnerBlob || manifest.discovery_runner_git_blob !== runnerBlob) fail(11, "discovery runner blob mismatch", 7)
const validatorBlob = git(options.tree, ["rev-parse", `${options.entrySha}:scripts/validate-entry-evidence.ts`])
const runtimeValidatorPath = path.resolve(import.meta.path)
if (
  validatorBlob === undefined ||
  runtimeValidatorPath !== path.join(realpathSync(options.tree), "scripts/validate-entry-evidence.ts") ||
  git(options.tree, ["hash-object", "--no-filters", runtimeValidatorPath]) !== validatorBlob
)
  fail(11, "validator provenance mismatch", 7)
const receipt = {
  schema_version: 1,
  validator_path: "scripts/validate-entry-evidence.ts",
  validator_git_blob: validatorBlob,
  entry_sha: options.entrySha,
  pointer_sha: options.pointerSha,
  manifest_path: pointer.manifestPath,
  manifest_sha256: pointer.manifestSha,
  discovery_baseline_path: entryBaselinePath,
  discovery_baseline_sha256: manifest.discovery_baseline_sha256,
  discovery_runner_git_blob: runnerBlob,
  validated_at: new Date().toISOString(),
  verdict: "green",
}
try {
  writeReceiptAtomically(options.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`)
} catch {
  console.error("FAIL receipt: receipt write failed")
  process.exit(8)
}
console.log(`receipt=${options.receiptOut}`)
console.log(`receipt_sha256=${sha256(options.receiptOut)}`)

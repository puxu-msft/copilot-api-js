#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"

import type { DiscoveryBaseline } from "./entry-evidence-schema"
import type { JUnitIdentities } from "./parallel-test-artifacts"

let writeReceiptAtomically!: (receiptPath: string, body: string) => void
let parseDiscoveryBaseline!: (raw: string) => DiscoveryBaseline
let parseJUnit!: (raw: string, tree: string) => JUnitIdentities

async function loadRuntimeDependencies(): Promise<void> {
  const receipt = await import("./entry-evidence-receipt")
  const schema = await import("./entry-evidence-schema")
  const junit = await import("./parallel-test-artifacts")
  writeReceiptAtomically = receipt.writeReceiptAtomically
  parseDiscoveryBaseline = schema.parseDiscoveryBaseline
  parseJUnit = junit.parseJUnit
}

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
const RUNTIME_DEPENDENCIES = [
  { importSpecifier: "./entry-evidence-receipt", path: "scripts/entry-evidence-receipt.ts" },
  { importSpecifier: "./entry-evidence-schema", path: "scripts/entry-evidence-schema.ts" },
  { importSpecifier: "./parallel-test-artifacts", path: "scripts/parallel-test-artifacts.ts" },
]

function runtimeImportSpecifiers(source: string): string[] | undefined {
  try {
    const scan = new Bun.Transpiler({ loader: "ts" }).scan(source)
    const localSpecifiers: string[] = []
    for (const imported of scan.imports) {
      if (imported.path.startsWith("./")) localSpecifiers.push(imported.path)
      else if (!imported.path.startsWith("node:")) return undefined
    }
    return localSpecifiers.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  } catch {
    return undefined
  }
}

function matchesEntryObject(tree: string, entrySha: string, runtimePath: string, entryPath: string): boolean {
  try {
    const canonicalTree = realpathSync(tree)
    if (realpathSync(runtimePath) !== path.join(canonicalTree, entryPath)) return false
  } catch {
    return false
  }
  const entryBlob = git(tree, ["rev-parse", `${entrySha}:${entryPath}`])
  return entryBlob !== undefined && git(tree, ["hash-object", "--no-filters", runtimePath]) === entryBlob
}

function runtimeClosureMatchesEntry(tree: string, entrySha: string): boolean {
  const runtimeValidatorPath = path.resolve(import.meta.path)
  if (!matchesEntryObject(tree, entrySha, runtimeValidatorPath, "scripts/validate-entry-evidence.ts")) return false
  let source: string
  try {
    source = readFileSync(runtimeValidatorPath, "utf8")
  } catch {
    return false
  }
  const imports = runtimeImportSpecifiers(source)
  const expectedImports = RUNTIME_DEPENDENCIES.map(({ importSpecifier }) => importSpecifier).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  )
  if (imports === undefined || JSON.stringify(imports) !== JSON.stringify(expectedImports)) return false
  return RUNTIME_DEPENDENCIES.every(({ importSpecifier, path: entryPath }) =>
    matchesEntryObject(tree, entrySha, path.join(path.dirname(runtimeValidatorPath), `${importSpecifier.slice(2)}.ts`), entryPath),
  )
}

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
function hashMatches(filePath: string, expected: string): boolean {
  try {
    return sha256(filePath) === expected
  } catch {
    return false
  }
}
function readUtf8(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
}
function logField(log: string, name: string): string | undefined {
  return new RegExp(`^${name}=([^\\n]+)$`, "m").exec(log)?.[1]
}
function identityKey(identity: Record<string, unknown>): string | undefined {
  const testcaseKeys = ["kind", "file", "classname", "name", "ordinal", "count"]
  const suiteKeys = ["kind", "file", "suite_name", "count"]
  if (
    identity.kind === "testcase" &&
    exactKeys(identity, testcaseKeys) &&
    typeof identity.file === "string" &&
    typeof identity.classname === "string" &&
    typeof identity.name === "string" &&
    Number.isSafeInteger(identity.ordinal) &&
    (identity.ordinal as number) > 0 &&
    Number.isSafeInteger(identity.count) &&
    (identity.count as number) > 0
  )
    return ["testcase", identity.file, identity.classname, identity.name, identity.ordinal, identity.count].join("\0")
  if (
    identity.kind === "suite" &&
    exactKeys(identity, suiteKeys) &&
    typeof identity.file === "string" &&
    typeof identity.suite_name === "string" &&
    Number.isSafeInteger(identity.count) &&
    (identity.count as number) > 0
  )
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

function directArtifactChild(child: string, parent: string): boolean {
  if (!existsSync(parent) || !existsSync(child)) return false
  try {
    return path.dirname(realpathSync(child)) === realpathSync(parent)
  } catch {
    return false
  }
}

function parseAggregateRows(raw: string): Array<{ ordinal: number; path: string; sha256: string }> | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ["runs"]) || !Array.isArray((value as Record<string, unknown>).runs))
    return undefined
  const rows = (value as { runs: unknown[] }).runs.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || !exactKeys(row as Record<string, unknown>, ["ordinal", "path", "sha256"])) return undefined
    const entry = row as Record<string, unknown>
    return Number.isSafeInteger(entry.ordinal) && (entry.ordinal as number) > 0 && typeof entry.path === "string" && path.isAbsolute(entry.path) && isSha(entry.sha256, 64)
      ? { ordinal: entry.ordinal as number, path: entry.path, sha256: entry.sha256 }
      : undefined
  })
  return rows.some((row) => row === undefined) ? undefined : (rows as Array<{ ordinal: number; path: string; sha256: string }>)
}

function uniqueAggregateRows(rows: Array<{ ordinal: number; path: string; sha256: string }>): boolean {
  return new Set(rows.map((row) => row.ordinal)).size === rows.length && new Set(rows.map((row) => row.path)).size === rows.length
}

function sameAggregateRows(actual: Array<{ ordinal: number; path: string; sha256: string }>, expected: Array<{ ordinal: number; path: string; sha256: string }>): boolean {
  const key = (row: { ordinal: number; path: string; sha256: string }) => `${row.ordinal}\0${row.path}\0${row.sha256}`
  const actualKeys = actual.map(key).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  const expectedKeys = expected.map(key).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  return actual.length === 15 && expected.length === 15 && uniqueAggregateRows(actual) && uniqueAggregateRows(expected) && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
}

function sameBytewiseStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => Buffer.from(value).compare(Buffer.from(right[index])) === 0)
}

function parseDiskManifest(raw: string): string[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ["files"]) || !Array.isArray((value as Record<string, unknown>).files)) return undefined
  const files = (value as { files: unknown[] }).files
  return files.every((file) => typeof file === "string") ? (files as string[]) : undefined
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
  if (junitArtifacts.some((artifact) => !artifact) || !runtimeArtifact) fail(7, "JUnit file identity mismatch", 6)
  const resolvedJunit = junitArtifacts as Array<{ path: string; sha256: string }>
  const paths = resolvedJunit.map((artifact) => artifact.path)
  const names = paths.map((file) => path.basename(file))
  if (
    new Set(paths).size !== paths.length ||
    !names.every((name) => /^shard-\d{2}\.xml$/.test(name)) ||
    names.some((name, index) => index > 0 && Buffer.from(names[index - 1]).compare(Buffer.from(name)) >= 0) ||
    resolvedJunit.some(
      (artifact) => !directArtifactChild(artifact.path, artifactDir) || !existsSync(artifact.path) || !hashMatches(artifact.path, artifact.sha256),
    ) ||
    path.basename(runtimeArtifact.path) !== "runtime-identity.json" ||
    !directArtifactChild(runtimeArtifact.path, artifactDir) ||
    !existsSync(runtimeArtifact.path) ||
    !hashMatches(runtimeArtifact.path, runtimeArtifact.sha256)
  )
    fail(7, "JUnit file identity mismatch", 6)
  if (
    !skippedArtifact ||
    path.basename(skippedArtifact.path) !== "skipped-multiset.json" ||
    !directArtifactChild(skippedArtifact.path, artifactDir) ||
    !existsSync(skippedArtifact.path) ||
    !hashMatches(skippedArtifact.path, skippedArtifact.sha256)
  )
    fail(8, "skipped identity multiset mismatch", 6)
  let actualJunit: Array<string>
  try {
    actualJunit = readdirSync(artifactDir)
      .filter((name) => /^shard-\d+\.xml$/.test(name))
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  } catch {
    fail(7, "JUnit file identity mismatch", 6)
  }
  if (JSON.stringify(actualJunit) !== JSON.stringify(names)) fail(7, "JUnit file identity mismatch", 6)
  return { junit: resolvedJunit, runtime: runtimeArtifact, skipped: skippedArtifact, artifactDir }
}

const options = parseOptions(process.argv.slice(2))
if (!existsSync(options.tree) || git(options.tree, ["cat-file", "-e", `${options.pointerSha}^{commit}`]) === undefined)
  fail(1, "pointer SHA does not resolve", 3)
if (!runtimeClosureMatchesEntry(options.tree, options.entrySha)) fail(11, "validator provenance mismatch", 7)
try {
  await loadRuntimeDependencies()
} catch {
  fail(11, "validator provenance mismatch", 7)
}
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
if (!hashMatches(pointer.manifestPath, pointer.manifestSha)) fail(5, "evidence manifest hash mismatch", 4)
if (canonicalInside(options.receiptOut, options.tree)) cliFail()
const manifestRaw = readUtf8(pointer.manifestPath)
if (manifestRaw === undefined) fail(5, "evidence manifest hash mismatch", 4)
const runs = parseManifest(manifestRaw)
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
  let canonicalLogPath: string
  try {
    canonicalLogPath = realpathSync(run.log_path)
  } catch {
    fail(6, "run log missing", 5)
  }
  canonicalLogPaths.push(canonicalLogPath)
  if (!hashMatches(canonicalLogPath, run.log_sha256)) fail(6, "run log hash mismatch", 5)
}
if (new Set(canonicalLogPaths).size !== runs.length) fail(6, "run log paths are not unique", 5)

let manifest: Record<string, unknown>
try {
  manifest = JSON.parse(manifestRaw) as Record<string, unknown>
} catch {
  fail(5, "evidence manifest hash mismatch", 4)
}
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
  if (typeof run.artifact_dir !== "string" || logField(log, "artifact_dir") !== run.artifact_dir) fail(9, "artifact directory mismatch", 7)
  const artifacts = parseRunArtifacts(run, options.tree)
  let junit: JUnitIdentities[]
  try {
    junit = artifacts.junit.map((artifact) => {
      const raw = readUtf8(artifact.path)
      if (raw === undefined) throw new Error("JUnit unreadable")
      return parseJUnit(raw, options.tree)
    })
  } catch {
    fail(7, "JUnit file identity mismatch", 6)
  }
  const files = [...new Set(junit.flatMap((item) => item.files))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (JSON.stringify(files) !== JSON.stringify(baseline.files)) fail(7, "JUnit file identity mismatch", 6)
  let runtime: unknown
  try {
    const raw = readUtf8(artifacts.runtime.path)
    if (raw === undefined) throw new Error("runtime identity unreadable")
    runtime = JSON.parse(raw)
  } catch {
    fail(7, "JUnit file identity mismatch", 6)
  }
  let skipped: unknown
  try {
    const raw = readUtf8(artifacts.skipped.path)
    if (raw === undefined) throw new Error("skipped multiset unreadable")
    skipped = JSON.parse(raw)
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
function topLevelArtifact(label: string, artifact: unknown): { path: string; sha256: string } {
  if (!artifact || typeof artifact !== "object" || !exactKeys(artifact as Record<string, unknown>, ["path", "sha256"])) fail(10, `${label} hash mismatch`, 7)
  const value = artifact as Record<string, unknown>
  if (typeof value.path !== "string" || !path.isAbsolute(value.path) || !isSha(value.sha256, 64) || !existsSync(value.path) || !hashMatches(value.path, value.sha256))
    fail(10, `${label} hash mismatch`, 7)
  return { path: value.path, sha256: value.sha256 }
}

const diskManifest = topLevelArtifact("disk manifest", manifest.disk_manifest)
const runtimeAggregate = topLevelArtifact("runtime identity manifest", manifest.runtime_identity_manifest)
const skippedAggregate = topLevelArtifact("skipped multiset", manifest.skipped_multiset)
const diskFilesRaw = readUtf8(diskManifest.path)
const runtimeAggregateRaw = readUtf8(runtimeAggregate.path)
const skippedAggregateRaw = readUtf8(skippedAggregate.path)
const runtimeRows = runtimeAggregateRaw === undefined ? undefined : parseAggregateRows(runtimeAggregateRaw)
const skippedRows = skippedAggregateRaw === undefined ? undefined : parseAggregateRows(skippedAggregateRaw)
const expectedRuntimeRows = (manifest.runs as Array<Record<string, unknown>>).map((run) => ({ ordinal: run.ordinal as number, ...(run.runtime_identity as { path: string; sha256: string }) }))
const expectedSkippedRows = (manifest.runs as Array<Record<string, unknown>>).map((run) => ({ ordinal: run.ordinal as number, ...(run.skipped_multiset as { path: string; sha256: string }) }))
if (
  diskFilesRaw === undefined ||
  parseDiskManifest(diskFilesRaw) === undefined ||
  !sameBytewiseStrings(parseDiskManifest(diskFilesRaw)!, baseline.files) ||
  runtimeRows === undefined ||
  skippedRows === undefined ||
  !sameAggregateRows(runtimeRows, expectedRuntimeRows) ||
  !sameAggregateRows(skippedRows, expectedSkippedRows)
)
  fail(10, "aggregate artifact mismatch", 7)
const entryBaselinePath = "tests/infra/entry-test-discovery-baseline.json"
if (manifest.discovery_baseline_path !== entryBaselinePath) fail(11, "discovery baseline path differs from entry", 7)
const runnerBlob = git(options.tree, ["rev-parse", `${options.entrySha}:scripts/parallel-test.ts`])
if (runnerBlob === undefined) fail(11, "discovery baseline hash mismatch", 7)
if (createHash("sha256").update(baselineBytes!).digest("hex") !== manifest.discovery_baseline_sha256) fail(11, "discovery baseline hash mismatch", 7)
if (baseline.runner_git_blob !== runnerBlob || manifest.discovery_runner_git_blob !== runnerBlob) fail(11, "discovery runner blob mismatch", 7)
const validatorBlob = git(options.tree, ["rev-parse", `${options.entrySha}:scripts/validate-entry-evidence.ts`])
if (validatorBlob === undefined) fail(11, "validator provenance mismatch", 7)
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

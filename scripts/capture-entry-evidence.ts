#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { Glob } from "bun"

import { parseDiscoveryBaseline, type SuiteSkip, type TestcaseSkip } from "./entry-evidence-schema"
import { parseJUnit, type SkippedIdentity } from "./parallel-test-artifacts"

interface Options {
  tree: string
  entrySha: string
  out: string
  runs: number
  discoveryBaseline: string
}

interface ArtifactHash {
  path: string
  sha256: string
}

interface RunArtifact {
  ordinal: number
  log_path: string
  log_sha256: string
  artifact_dir: string
  junit_artifacts: Array<ArtifactHash>
  runtime_identity: ArtifactHash
  skipped_multiset: ArtifactHash
  executed: number
  skipped: number
  verdict: "green"
}

function fail(code: number, message: string): never {
  console.error(`capture-entry-evidence: ${message}`)
  process.exit(code)
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function parseOptions(argv: Array<string>): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) fail(2, "CLI arguments are invalid")
    values.set(flag, value)
  }
  if (values.size !== 5 || [...values.keys()].some((flag) => !["--tree", "--entry-sha", "--out", "--runs", "--discovery-baseline"].includes(flag)))
    fail(2, "CLI arguments are invalid")
  const tree = values.get("--tree")!
  const entrySha = values.get("--entry-sha")!
  const out = values.get("--out")!
  const runs = Number(values.get("--runs"))
  const discoveryBaseline = values.get("--discovery-baseline")!
  if (!path.isAbsolute(tree) || !path.isAbsolute(out) || !/^[0-9a-f]{40}$/.test(entrySha) || !Number.isSafeInteger(runs) || runs !== 15)
    fail(2, "CLI arguments are invalid")
  return { tree, entrySha, out, runs, discoveryBaseline }
}

function git(tree: string, args: Array<string>): string {
  const result = Bun.spawnSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  return result.stdout.toString().trim()
}

function isUnder(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function atomicWrite(filePath: string, body: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`)
  try {
    writeFileSync(temporary, body)
    renameSync(temporary, filePath)
  } catch (error) {
    // Only this invocation's deterministic temporary path is ours to remove.
    // The target may predate this invocation and must never be touched on failure.
    rmSync(temporary, { force: true })
    throw error
  }
}

function discover(tree: string): Array<string> {
  const found = new Set<string>()
  for (const suffix of ["unit", "it", "http"]) {
    for (const candidate of new Glob(`**/*.${suffix}.test.ts`).scanSync({ cwd: path.join(tree, "tests"), onlyFiles: true })) found.add(`tests/${candidate}`)
  }
  return [...found].sort()
}

function readLogField(log: string, field: string): string | undefined {
  return new RegExp(`^${field}=([^\n]+)$`, "m").exec(log)?.[1]
}

function compareSets(expected: Array<string>, actual: Array<string>): boolean {
  return expected.length === actual.length && expected.every((value, index) => value === actual[index])
}

function formatIdentity(identity: TestcaseSkip | SuiteSkip | SkippedIdentity): string {
  return JSON.stringify(identity)
}

function baselineSkipKey(skip: TestcaseSkip | SuiteSkip): string {
  return skip.kind === "testcase"
    ? [skip.kind, skip.file, skip.classname, skip.name, skip.ordinal].join("\0")
    : [skip.kind, skip.file, skip.suite_name].join("\0")
}

function runtimeSkipKey(skip: SkippedIdentity): string {
  return skip.kind === "testcase"
    ? [skip.kind, skip.file, skip.classname, skip.name, skip.ordinal].join("\0")
    : [skip.kind, skip.file, skip.suite_name].join("\0")
}

function assertSkippedMultiset(expected: Array<TestcaseSkip | SuiteSkip>, actual: Array<SkippedIdentity>): void {
  const expectedByKey = new Map(expected.map((skip) => [baselineSkipKey(skip), skip]))
  const actualByKey = new Map(actual.map((skip) => [runtimeSkipKey(skip), skip]))
  const missing = [...expectedByKey.keys()].filter((key) => !actualByKey.has(key)).map((key) => formatIdentity(expectedByKey.get(key)!))
  const unexpected = [...actualByKey.keys()].filter((key) => !expectedByKey.has(key)).map((key) => formatIdentity(actualByKey.get(key)!))
  const mismatchedCounts = [...expectedByKey.keys()]
    .filter((key) => actualByKey.has(key) && expectedByKey.get(key)!.count !== actualByKey.get(key)!.count)
    .map((key) => `${formatIdentity(expectedByKey.get(key)!)} expected_count=${expectedByKey.get(key)!.count} actual_count=${actualByKey.get(key)!.count}`)
  if (missing.length > 0 || unexpected.length > 0 || mismatchedCounts.length > 0)
    throw new Error(
      `skipped identity multiset mismatch: missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}] count_mismatch=[${mismatchedCounts.join(", ")}]`,
    )
}

function readRunArtifact(
  tree: string,
  out: string,
  ordinal: number,
  baselineFiles: Array<string>,
  minimumExecuted: number,
  allowedSkipped: Array<TestcaseSkip | SuiteSkip>,
): RunArtifact {
  const logPath = path.join(out, `run-${String(ordinal).padStart(2, "0")}.log`)
  if (!existsSync(logPath)) throw new Error("run log is missing")
  const log = readFileSync(logPath, "utf8")
  const artifactDir = readLogField(log, "artifact_dir")
  if (!artifactDir || !path.isAbsolute(artifactDir) || !isUnder(artifactDir, out) || !existsSync(artifactDir))
    throw new Error("run artifact transfer is missing")
  const junitPaths = readdirSync(artifactDir)
    .filter((name) => /^shard-\d+\.xml$/.test(name))
    .sort()
    .map((name) => path.join(artifactDir, name))
  const runtimeIdentityPath = path.join(artifactDir, "runtime-identity.json")
  const skippedMultisetPath = path.join(artifactDir, "skipped-multiset.json")
  if (junitPaths.length === 0 || !existsSync(runtimeIdentityPath) || !existsSync(skippedMultisetPath)) throw new Error("run artifact transfer is incomplete")
  const runtimeFiles = JSON.parse(readFileSync(runtimeIdentityPath, "utf8")).files as Array<string>
  const skipped = JSON.parse(readFileSync(skippedMultisetPath, "utf8")) as { executed: number; skipped: number; skipped_identities: Array<SkippedIdentity> }
  const junitFiles = new Set<string>()
  for (const junitPath of junitPaths) for (const file of parseJUnit(readFileSync(junitPath, "utf8"), tree).files) junitFiles.add(file)
  if (!compareSets(baselineFiles, [...junitFiles].sort()) || !compareSets(baselineFiles, runtimeFiles) || skipped.executed < minimumExecuted)
    throw new Error("runtime identity differs from discovery baseline")
  assertSkippedMultiset(allowedSkipped, skipped.skipped_identities)
  return {
    ordinal,
    log_path: logPath,
    log_sha256: sha256(logPath),
    artifact_dir: artifactDir,
    junit_artifacts: junitPaths.map((junitPath) => ({ path: junitPath, sha256: sha256(junitPath) })),
    runtime_identity: { path: runtimeIdentityPath, sha256: sha256(runtimeIdentityPath) },
    skipped_multiset: { path: skippedMultisetPath, sha256: sha256(skippedMultisetPath) },
    executed: skipped.executed,
    skipped: skipped.skipped,
    verdict: "green",
  }
}

const options = parseOptions(process.argv.slice(2))
try {
  if (existsSync(options.out) && readdirSync(options.out).length > 0) fail(2, "--out must be absent or empty")
  if (isUnder(options.out, options.tree)) fail(2, "--out must be outside --tree")
  if (git(options.tree, ["rev-parse", "HEAD"]) !== options.entrySha || git(options.tree, ["status", "--porcelain"]) !== "")
    fail(3, "entry tree does not match a clean entry SHA")

  const baselinePath = path.join(options.tree, options.discoveryBaseline)
  if (!existsSync(baselinePath)) fail(4, "discovery baseline is missing")
  const baselineRaw = readFileSync(baselinePath, "utf8")
  const baseline = parseDiscoveryBaseline(baselineRaw)
  const baselineHash = sha256(baselinePath)
  const runnerBlob = git(options.tree, ["rev-parse", `${options.entrySha}:scripts/parallel-test.ts`])
  if (baseline.runner_git_blob !== runnerBlob || !compareSets(baseline.files, discover(options.tree))) fail(4, "discovery baseline differs from entry tree")

  mkdirSync(options.out, { recursive: true })
  const diskManifestPath = path.join(options.out, "disk-manifest.json")
  atomicWrite(diskManifestPath, `${JSON.stringify({ files: baseline.files }, null, 2)}\n`)
  const wrapper = path.join(options.tree, "exp/inter-block-anchor-allocator/baseline-runs.sh")
  const wrapperRun = Bun.spawnSync(["bash", wrapper], {
    cwd: options.tree,
    env: {
      ...process.env,
      OUT: options.out,
      RUNS: String(options.runs),
      MIN_RUNS: String(options.runs),
      MIN_TESTS: String(baseline.minimum_executed),
      EVIDENCE_TIMING: "closeout",
      REQUIRE_TEST_ARTIFACTS: "1",
      ALLOW_DIRTY: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (wrapperRun.exitCode !== 0) fail(5, wrapperRun.stderr.toString().trim() || "baseline runner failed")

  const runs: Array<RunArtifact> = []
  for (let ordinal = 1; ordinal <= options.runs; ordinal += 1)
    runs.push(readRunArtifact(options.tree, options.out, ordinal, baseline.files, baseline.minimum_executed, baseline.allowed_skipped))
  const runtimeIdentityManifestPath = path.join(options.out, "runtime-identity-manifest.json")
  const skippedMultisetManifestPath = path.join(options.out, "skipped-multiset-manifest.json")
  atomicWrite(
    runtimeIdentityManifestPath,
    `${JSON.stringify({ runs: runs.map(({ ordinal, runtime_identity }) => ({ ordinal, ...runtime_identity })) }, null, 2)}\n`,
  )
  atomicWrite(
    skippedMultisetManifestPath,
    `${JSON.stringify({ runs: runs.map(({ ordinal, skipped_multiset }) => ({ ordinal, ...skipped_multiset })) }, null, 2)}\n`,
  )
  const manifestPath = path.join(options.out, "evidence-manifest.json")
  try {
    atomicWrite(
      manifestPath,
      `${JSON.stringify({ schema_version: 1, measured_sha: options.entrySha, evidence_timing: "closeout", claims_current_head: true, out_dir: options.out, canonical_command: "bun scripts/parallel-test.ts unit it http", discovery_baseline_path: options.discoveryBaseline, discovery_baseline_sha256: baselineHash, discovery_runner_git_blob: runnerBlob, disk_manifest: { path: diskManifestPath, sha256: sha256(diskManifestPath) }, runtime_identity_manifest: { path: runtimeIdentityManifestPath, sha256: sha256(runtimeIdentityManifestPath) }, skipped_multiset: { path: skippedMultisetManifestPath, sha256: sha256(skippedMultisetManifestPath) }, runs }, null, 2)}\n`,
    )
  } catch (error) {
    fail(6, `manifest write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  console.log(`manifest=${manifestPath}`)
  console.log(`manifest_sha256=${sha256(manifestPath)}`)
} catch (error) {
  rmSync(path.join(options.out, "evidence-manifest.json"), { force: true })
  if (typeof error === "object" && error && "code" in error) throw error
  fail(5, error instanceof Error ? error.message : String(error))
}

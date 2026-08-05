#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { Glob } from "bun"

import { parseDiscoveryBaseline } from "./entry-evidence-schema"
import { parseJUnit } from "./parallel-test-artifacts"

interface Options {
  tree: string
  entrySha: string
  out: string
  runs: number
  discoveryBaseline: string
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
  writeFileSync(temporary, body)
  renameSync(temporary, filePath)
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
  const command = ["bash", wrapper]
  const wrapperRun = Bun.spawnSync(command, {
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

  const runs = [] as Array<Record<string, unknown>>
  for (let ordinal = 1; ordinal <= options.runs; ordinal += 1) {
    const logPath = path.join(options.out, `run-${String(ordinal).padStart(2, "0")}.log`)
    if (!existsSync(logPath)) fail(5, "run log is missing")
    const log = readFileSync(logPath, "utf8")
    const artifactDir = readLogField(log, "artifact_dir")
    if (!artifactDir || !path.isAbsolute(artifactDir) || !isUnder(artifactDir, options.out) || !existsSync(artifactDir))
      fail(5, "run artifact transfer is missing")
    const junitPaths = readdirSync(artifactDir)
      .filter((name) => /^shard-\d+\.xml$/.test(name))
      .sort()
      .map((name) => path.join(artifactDir, name))
    const runtimeIdentityPath = path.join(artifactDir, "runtime-identity.json")
    const skippedMultisetPath = path.join(artifactDir, "skipped-multiset.json")
    if (junitPaths.length === 0 || !existsSync(runtimeIdentityPath) || !existsSync(skippedMultisetPath)) fail(5, "run artifact transfer is incomplete")
    const runtimeFiles = JSON.parse(readFileSync(runtimeIdentityPath, "utf8")).files as Array<string>
    const skipped = JSON.parse(readFileSync(skippedMultisetPath, "utf8")) as {
      executed: number
      skipped: number
      skipped_identities: Array<Record<string, unknown>>
    }
    const junitFiles = new Set<string>()
    for (const junitPath of junitPaths) for (const file of parseJUnit(readFileSync(junitPath, "utf8"), options.tree).files) junitFiles.add(file)
    if (!compareSets(baseline.files, [...junitFiles].sort()) || !compareSets(baseline.files, runtimeFiles) || skipped.executed < baseline.minimum_executed)
      fail(5, "runtime identity differs from discovery baseline")
    runs.push({
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
    })
  }
  const manifestPath = path.join(options.out, "evidence-manifest.json")
  atomicWrite(
    manifestPath,
    `${JSON.stringify({ schema_version: 1, measured_sha: options.entrySha, evidence_timing: "closeout", claims_current_head: true, out_dir: options.out, canonical_command: "bun scripts/parallel-test.ts unit it http", discovery_baseline_path: options.discoveryBaseline, discovery_baseline_sha256: baselineHash, discovery_runner_git_blob: runnerBlob, disk_manifest: { path: diskManifestPath, sha256: sha256(diskManifestPath) }, runs }, null, 2)}\n`,
  )
  console.log(`manifest=${manifestPath}`)
  console.log(`manifest_sha256=${sha256(manifestPath)}`)
} catch (error) {
  rmSync(path.join(options.out, "evidence-manifest.json"), { force: true })
  if (typeof error === "object" && error && "code" in error) throw error
  fail(5, error instanceof Error ? error.message : String(error))
}

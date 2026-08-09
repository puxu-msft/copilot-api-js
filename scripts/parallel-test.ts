#!/usr/bin/env bun
/**
 * Balanced parallel test runner.
 *
 * `bun test --parallel` forces `--isolate` (a fresh module context per file), so the
 * heavy `~/lib/*` graph is re-imported ~440 times — that re-import, not the tests
 * themselves, dominates the wall (12s). This runner instead LPT-balances the matched
 * files into `nproc` buckets by known per-file time and runs each bucket as ONE
 * single-process `bun test` (module cache shared within a bucket → imported once per
 * bucket, not per file). Measured ~6s vs 12s for the fast tier.
 *
 * Trade-off vs `--isolate`: files in the same bucket share module-global state, so a
 * leaky test could pollute a bucket-mate. Per-file isolation via the fixture afterEach
 * (`RESETTERS` + `resetTestRuntime`) still runs; this only loses the process-level
 * isolate. Use `bun test --parallel <filter>` (the `:isolated` scripts) when hunting
 * pollution.
 *
 * Usage:
 *   bun scripts/parallel-test.ts unit http          # fast tier
 *   bun scripts/parallel-test.ts unit it http        # backend
 *   bun scripts/parallel-test.ts --update unit http  # refresh timing cache, then run
 *
 * Timing cache: `scripts/test-timings.json` (committed; a perf hint, not correctness).
 * Unknown/new files fall back to the median. Balance degrades gracefully as files are
 * added; run `--update` occasionally to refresh.
 */
import { Glob } from "bun"
import {
  //
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  //
  compareFileIdentities,
  parseJUnit,
} from "./parallel-test-artifacts"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const TIMINGS_PATH = path.join(REPO_ROOT, "scripts/test-timings.json")

const argv = process.argv.slice(2)
const update = argv.includes("--update")
const suffixes = argv.filter((a) => !a.startsWith("--"))
if (suffixes.length === 0) {
  console.error("usage: parallel-test.ts [--update] <suffix...>   e.g. unit http")
  process.exit(2)
}

function discover(): Array<string> {
  const out: Array<string> = []
  for (const suf of suffixes) {
    const g = new Glob(`**/*.${suf}.test.ts`)
    for (const p of g.scanSync({ cwd: path.join(REPO_ROOT, "tests"), onlyFiles: true })) out.push(`tests/${p}`)
  }
  return out.sort()
}

async function loadTimings(): Promise<Record<string, number>> {
  if (!existsSync(TIMINGS_PATH)) return {}
  try {
    return JSON.parse(await Bun.file(TIMINGS_PATH).text()) as Record<string, number>
  } catch {
    return {}
  }
}

/** Run each shard with a junit reporter, merge per-file times, rewrite the cache. */
async function refreshTimings(files: Array<string>): Promise<void> {
  const xml = path.join(os.tmpdir(), `ptt-${process.pid}.xml`)
  const proc = Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${xml}`, ...files], {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  })
  await proc.exited
  const text = await Bun.file(xml).text()
  const times: Record<string, number> = {}
  // Extract file + time per <testcase> (bun emits them in the order name,classname,
  // time,file,line — so match the element then pull each attr order-independently).
  for (const tc of text.matchAll(/<testcase\b[^>]*>/g)) {
    const el = tc[0]
    const f = /\bfile="([^"]+)"/.exec(el)?.[1]
    const t = /\btime="([\d.]+)"/.exec(el)?.[1]
    if (!f || t === undefined) continue
    const rel = f.replace(`${REPO_ROOT}/`, "")
    times[rel] = (times[rel] ?? 0) + Number(t)
  }
  await Bun.write(TIMINGS_PATH, `${JSON.stringify(times, Object.keys(times).sort(), 2)}\n`)
  console.error(`[parallel-test] refreshed ${Object.keys(times).length} timings → scripts/test-timings.json`)
}

function median(vals: Array<number>): number {
  if (vals.length === 0) return 0.05
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Longest-processing-time greedy bin packing into `n` buckets. */
function balance(files: Array<string>, times: Record<string, number>, n: number): Array<Array<string>> {
  const med = median(Object.values(times))
  const sorted = [...files].sort((a, b) => (times[b] ?? med) - (times[a] ?? med))
  const buckets: Array<Array<string>> = Array.from({ length: n }, () => [])
  const loads: Array<number> = Array.from({ length: n }, () => 0)
  for (const f of sorted) {
    let min = 0
    for (let i = 1; i < n; i++) if (loads[i] < loads[min]) min = i
    buckets[min].push(f)
    loads[min] += times[f] ?? med
  }
  return buckets.filter((b) => b.length > 0)
}

const files = discover()
if (files.length === 0) {
  console.error(`[parallel-test] no files match: ${suffixes.join(", ")}`)
  process.exit(1)
}

if (update) await refreshTimings(files)

const timings = await loadTimings()
const n = Math.min(files.length, os.cpus().length)
const buckets = balance(files, timings, n)
const requestedArtifactDir = process.env.PARALLEL_TEST_ARTIFACT_DIR
const artifactDir = requestedArtifactDir ?? mkdtempSync(path.join(os.tmpdir(), "parallel-test-"))
if (requestedArtifactDir) {
  if (!path.isAbsolute(requestedArtifactDir)) {
    console.error("[parallel-test] PARALLEL_TEST_ARTIFACT_DIR must be absolute")
    process.exit(2)
  }
  if (existsSync(requestedArtifactDir) && readdirSync(requestedArtifactDir).length > 0) {
    console.error(`[parallel-test] PARALLEL_TEST_ARTIFACT_DIR must be absent or empty: ${requestedArtifactDir}`)
    process.exit(2)
  }
  mkdirSync(requestedArtifactDir, { recursive: true })
}

const start = performance.now()
const procs = buckets.map((bucket, index) => {
  const junitName = `shard-${String(index + 1).padStart(2, "0")}.xml`
  const junitPath = path.join(artifactDir, junitName)
  const temporaryJunitPath = path.join(artifactDir, `.${junitName}.tmp`)
  return {
    bucket,
    junitPath,
    temporaryJunitPath,
    process: Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${temporaryJunitPath}`, ...bucket], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    }),
  }
})
const results = await Promise.all(
  procs.map(async ({ bucket, junitPath, temporaryJunitPath, process }) => {
    // Start draining both pipes BEFORE awaiting exit. Awaiting `exited` first
    // leaves nobody reading, so a shard whose output exceeds the pipe buffer
    // blocks in write() and its summary line can be lost or truncated — which
    // silently under-counts a different subset of shards on every run while the
    // aggregate still looks plausible enough to quote as evidence.
    const [code, err, out] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()])
    if (existsSync(temporaryJunitPath)) renameSync(temporaryJunitPath, junitPath)
    return { bucket, code, junitPath, err: err + out }
  }),
)
const wall = ((performance.now() - start) / 1000).toFixed(2)

// Surface failures verbatim (bun writes the summary + failing assertions to stderr).
const failed = results.filter((r) => r.code !== 0)
for (const r of failed) process.stderr.write(r.err)

// A shard that exited nonzero but printed no `N fail` summary died mid-run (crash / OOM /
// process.exit / a load-time throw) — its bucket-mates' real pass/fail were never reported,
// so a genuine assertion failure could hide behind a "crash". Re-run each crashed bucket
// with `--isolate` (one process per file) to pinpoint the culprit and recover the rest —
// closes the diagnosability gap without slowing the happy path (only runs on a crash).
const crashed = results.filter((r) => r.code !== 0 && !/\d+ fail\b/.test(r.err))
for (const r of crashed) {
  process.stderr.write(
    `\n[parallel-test] shard crashed (exit ${r.code}) mid-bucket — re-running its ${r.bucket.length} files isolated to pinpoint:\n  ${r.bucket.join("\n  ")}\n`,
  )
  const rerun = Bun.spawnSync(["bun", "test", "--isolate", ...r.bucket], { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" })
  if (rerun.exitCode !== 0) process.stderr.write(`[parallel-test] isolated re-run of crashed bucket exited ${rerun.exitCode}\n`)
}

function writeArtifactAtomically(filePath: string, body: string): void {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`)
  writeFileSync(temporaryPath, body)
  renameSync(temporaryPath, filePath)
}

const identities = results.map((result) => {
  if (!existsSync(result.junitPath)) {
    console.error(`[parallel-test] missing JUnit artifact for shard: ${result.junitPath}`)
    return undefined
  }
  return parseJUnit(readFileSync(result.junitPath, "utf8"), REPO_ROOT)
})
if (identities.includes(undefined)) process.exit(1)
const parsedIdentities = identities as Array<NonNullable<(typeof identities)[number]>>

const runtimeFiles = new Set(parsedIdentities.flatMap((identity) => identity.files))
const fileComparison = compareFileIdentities(files, [...runtimeFiles])
if (fileComparison.missing.length > 0 || fileComparison.unexpected.length > 0) {
  for (const file of fileComparison.missing) console.error(`[parallel-test] missing runtime file identity: ${file}`)
  for (const file of fileComparison.unexpected) console.error(`[parallel-test] unexpected runtime file identity: ${file}`)
}

const executed = parsedIdentities.reduce((sum, identity) => sum + identity.executed, 0)
const skipped = parsedIdentities.reduce((sum, identity) => sum + identity.skipped, 0)
const skippedIdentities = parsedIdentities.flatMap((identity) => identity.skippedIdentities)
writeArtifactAtomically(path.join(artifactDir, "runtime-identity.json"), `${JSON.stringify({ files: [...runtimeFiles].sort() }, null, 2)}\n`)
writeArtifactAtomically(
  path.join(artifactDir, "skipped-multiset.json"),
  `${JSON.stringify({ executed, skipped, skipped_identities: skippedIdentities }, null, 2)}\n`,
)

// Aggregate the pass/fail tallies from the JUnit artifacts, not from the shards' stdout.
// Stdout parsing was the original source and it reports a green `0 fail` whenever a shard
// dies while writing its summary: the `N fail` line never lands, but the failing testcase
// row was already flushed to the XML. Observed on a merge gate — a timed-out test sat in
// shard-06's XML while the tally line read `3337 tests · 3337 pass · 0 fail`. The pass
// count is derived (executed − failed) so it can never disagree with them.
const failSum = parsedIdentities.reduce((sum, identity) => sum + identity.failed, 0)
const failedIdentities = parsedIdentities.flatMap((identity) => identity.failedIdentities)
const passSum = executed - failSum
for (const identity of failedIdentities) {
  console.error(`[parallel-test] FAIL ${identity.file} › ${identity.classname} › ${identity.name} (${identity.type})`)
}

console.error(
  `\n[parallel-test] ${buckets.length} shards · ${executed} tests · `
    + `${passSum} pass · ${failSum} fail · ${executed} executed · ${skipped} skipped${crashed.length > 0 ? ` · ${crashed.length} shard(s) crashed (see isolated re-run above)` : ""} · ${wall}s`,
)
console.error(`[parallel-test] artifacts=${artifactDir}`)
process.exit(failed.length > 0 || failSum > 0 || fileComparison.missing.length > 0 || fileComparison.unexpected.length > 0 ? 1 : 0)

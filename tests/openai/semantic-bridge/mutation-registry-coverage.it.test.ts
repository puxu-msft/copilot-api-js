import {
  //
  expect,
  test,
} from "bun:test"
import { spawnSync } from "node:child_process"
import {
  //
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import {
  //
  join,
  resolve,
} from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const RFC_PATH = resolve(REPO_ROOT, "docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md")
const REGISTRY_PATH = resolve(import.meta.dir, "mutation-registry.md")
const KNOWN_LOSS_TEST_PATH = resolve(import.meta.dir, "known-defects.unit.test.ts")
const TEST_CONFIG_PATH = resolve(REPO_ROOT, "bunfig.toml")
const TEST_CONFIG_EXISTS = existsSync(TEST_CONFIG_PATH)

interface RegistryRow {
  id: string
  joinKey: string
}

const EXPECTED_RFC_ARM_IDS = [
  "RFC-RESP-LIFECYCLE",
  "RFC-ANTHROPIC-LIFECYCLE",
  "RFC-MULTI-REASONING",
  "RFC-ENCRYPTED-ONLY",
  "RFC-FUNCTION-ARGS-DONE",
  "RFC-ORDERED-TURN",
  "RFC-SERVER-TOOL",
  "RFC-SCENARIO-A-FORWARD",
  "RFC-SCENARIO-A-REVERSE",
  "RFC-SCENARIO-B-FORWARD",
  "RFC-SCENARIO-B-REVERSE",
  "RFC-FORWARD-TRANSLATE-OUT",
  "RFC-FORWARD-PREPARE-WIRE",
  "RFC-FORWARD-RETRY-BASELINE",
  "RFC-DELIVERY-AUTHORITY",
  "RFC-PRECOMMIT-WIRE-EFFECT",
  "RFC-PRECOMMIT-EMPTY-SEGMENT",
  "RFC-PRECOMMIT-FLUSH-FAIL",
  "RFC-OBSERVATION-SINGLE-STAGE",
  "RFC-OBSERVATION-WIRE-ACK",
  "RFC-OBSERVATION-EMPTY-RETAIN",
  "RFC-OBSERVATION-SEMANTIC",
  "RFC-SOURCE-DIAGNOSTICS",
  "RFC-CAPABILITY-POLICY",
  "RFC-CARRIER-PROVENANCE",
  "RFC-SAME-MODEL-REPLAY",
  "RFC-CUTOVER-FORWARD",
  "RFC-CUTOVER-REVERSE",
] as const

function tableRows(markdown: string, prefix: "RFC" | "LOSS"): Array<RegistryRow> {
  return markdown.split("\n").flatMap((line) => {
    const columns = line.split("|").map((column) => column.trim())
    const id = columns[1]?.match(/^`([^`]+)`$/)?.[1]
    const joinKey = columns[2]?.match(/^`([^`]+)`$/)?.[1]
    return id?.startsWith(`${prefix}-`) && joinKey ? [{ id, joinKey }] : []
  })
}

function rfcAcceptanceKeys(markdown: string): Array<string> {
  const section = markdown.split("## 12．验收矩阵\n", 2)[1]?.split("\n## ", 1)[0]
  if (!section) throw new Error("missing RFC §12 acceptance matrix")
  return section.split("\n").flatMap((line) => {
    const key = line.match(/^\| ([^|]+?) \|/)?.[1].trim()
    return key && key !== "性质" && !key.startsWith("---") ? [key] : []
  })
}

function runtimeKnownLossNames(): Array<string> {
  const tempDir = mkdtempSync(join(tmpdir(), "semantic-bridge-registry-"))
  const reportPath = join(tempDir, "known-loss.xml")
  try {
    const arguments_ = ["test", KNOWN_LOSS_TEST_PATH, "--reporter=junit", `--reporter-outfile=${reportPath}`]
    if (TEST_CONFIG_EXISTS) arguments_.push(`--config=${TEST_CONFIG_PATH}`)
    const run = spawnSync(process.execPath, arguments_, { cwd: REPO_ROOT, encoding: "utf8" })
    if (run.status !== 0) throw new Error(`KNOWN-LOSS runtime enumeration failed (${run.status}): ${run.stderr || run.stdout}`)
    // Match the whole element, not just the opening tag, and drop anything carrying <skipped/>. A
    // skipped case is still emitted as a <testcase> with the same name and the run still exits 0, so
    // reading only the name would enumerate what is *declared* rather than what actually *ran* — and
    // `test.skip` is precisely the evasion this registry documents under its own ACT-COVERAGE-SKIP-*
    // rows. Dropping them here rather than asserting separately makes the skipped name fall out of
    // the runtime set, so the join reports it as missing and names it.
    // `[^>]*?` must stay lazy. Greedy, it swallows the `/` of a self-closing tag, so the alternation
    // takes the `>` branch and `[\s\S]*?` runs on to the *next* case's `</testcase>` — dragging that
    // one's `<skipped` into this one's body and dropping a case that actually ran. The engine does
    // not backtrack to try `/>` because the `>` branch already succeeded. Measured on three cases
    // with only the middle one skipped: greedy yields ["gamma"], lazy yields ["alpha","gamma"].
    return [...readFileSync(reportPath, "utf8").matchAll(/<testcase name="(KNOWN-LOSS：[^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
      .filter((match) => !(match[2] ?? "").includes("<skipped"))
      .map((match) => match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function expectExactJoin(rows: Array<RegistryRow>, expectedKeys: Array<string>, label: string, allowSplitArms = false): void {
  const rowKeys = rows.map(({ joinKey }) => joinKey)
  expect(new Set(rows.map(({ id }) => id)).size, `${label} registry contains duplicate IDs`).toBe(rows.length)
  if (!allowSplitArms) expect(new Set(rowKeys).size, `${label} registry contains duplicate join keys`).toBe(rowKeys.length)
  expect(
    rowKeys.filter((key) => !expectedKeys.includes(key)),
    `${label} registry has unknown join keys`,
  ).toEqual([])
  expect(
    expectedKeys.filter((key) => !rowKeys.includes(key)),
    `${label} registry is missing source join keys`,
  ).toEqual([])
}

test("mutation registry RFC rows cover every RFC §12 acceptance row with the frozen per-arm ID set", () => {
  const rows = tableRows(readFileSync(REGISTRY_PATH, "utf8"), "RFC")
  expectExactJoin(rows, rfcAcceptanceKeys(readFileSync(RFC_PATH, "utf8")), "RFC", true)
  expect(rows.map(({ id }) => id).sort(), "RFC registry arm IDs differ from the reviewed split-arm set").toEqual([...EXPECTED_RFC_ARM_IDS].sort())
})

// This assertion starts a complete nested Bun test process. Its duration varies with host load, so Bun's
// fixed five-second default creates a load-dependent false-red under the parallel backend test runners.
test("mutation registry LOSS rows join one-to-one to the runtime KNOWN-LOSS testcase set", () => {
  expectExactJoin(tableRows(readFileSync(REGISTRY_PATH, "utf8"), "LOSS"), runtimeKnownLossNames(), "LOSS")
}, 120_000)

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
    return [...readFileSync(reportPath, "utf8").matchAll(/<testcase name="(KNOWN-LOSS：[^"]+)"/g)].map((match) =>
      match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
    )
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

test("mutation registry RFC rows cover every RFC §12 acceptance row with externally anchored join keys", () => {
  expectExactJoin(tableRows(readFileSync(REGISTRY_PATH, "utf8"), "RFC"), rfcAcceptanceKeys(readFileSync(RFC_PATH, "utf8")), "RFC", true)
})

test("mutation registry LOSS rows join one-to-one to the runtime KNOWN-LOSS testcase set", () => {
  expectExactJoin(tableRows(readFileSync(REGISTRY_PATH, "utf8"), "LOSS"), runtimeKnownLossNames(), "LOSS")
})

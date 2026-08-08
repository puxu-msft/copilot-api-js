import {
  //
  afterAll,
  beforeAll,
  expect,
  test,
} from "bun:test"
import {
  //
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
let buildDir = ""
let mainBundle = ""
let workerBundle = ""

interface ProbeResult {
  readonly selectedDriver: "bun:sqlite" | "node:sqlite"
  readonly n: number
}

beforeAll(async () => {
  buildDir = mkdtempSync(path.join(os.tmpdir(), "history-worker-build-"))
  mainBundle = path.join(buildDir, "main.mjs")
  workerBundle = path.join(buildDir, "history-worker.mjs")
  const child = Bun.spawn([process.execPath, "x", "tsdown", "--out-dir", buildDir], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`packaged Worker build exited ${exitCode}:\n${stdout}\n${stderr}`)
})

afterAll(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true })
})

async function probe(runtime: string): Promise<ProbeResult> {
  const child = Bun.spawn([runtime, workerBundle, "--probe"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`${runtime} probe exited ${exitCode}: ${stderr}`)
  return JSON.parse(stdout.trim()) as ProbeResult
}

test("backend build emits stable main and History Worker bundle paths", () => {
  expect(existsSync(mainBundle)).toBe(true)
  expect(existsSync(workerBundle)).toBe(true)
})

test("packaged History Worker probe selects each host runtime SQLite driver", async () => {
  expect(await probe(process.execPath)).toEqual({ selectedDriver: "bun:sqlite", n: 7 })
  expect(await probe("node")).toEqual({ selectedDriver: "node:sqlite", n: 7 })
})

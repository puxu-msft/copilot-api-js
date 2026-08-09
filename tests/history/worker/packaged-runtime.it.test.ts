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
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
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
  // Built INSIDE the repo, not in os.tmpdir(): the packaged Worker bundle imports the same
  // externalised runtime dependencies as `main.mjs` (consola and friends), and ESM resolves
  // those by walking up from the FILE, not from cwd. A temp dir outside the tree therefore
  // fails on Node with ERR_MODULE_NOT_FOUND while passing on Bun — an artefact of where the
  // test put the bundle, not of the bundle. `dist/` is already gitignored.
  mkdirSync(path.join(root, "dist"), { recursive: true })
  buildDir = mkdtempSync(path.join(root, "dist", "history-worker-build-"))
  mainBundle = path.join(buildDir, "main.mjs")
  workerBundle = path.join(buildDir, "history-worker.mjs")
  const child = Bun.spawn([process.execPath, "x", "tsdown", "--out-dir", buildDir], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`packaged Worker build exited ${exitCode}:\n${stdout}\n${stderr}`)
}, 30_000)

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

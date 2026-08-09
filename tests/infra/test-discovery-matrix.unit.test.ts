import { Glob } from "bun"
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

// 权威后缀集：每个后端测试文件必须恰好带其一，且必须位于 tests/（bunfig root=./tests
// 使 src/ 下的测试根本不被默认发现）。此守卫从结构上杜绝「已分档但无脚本运行」的孤儿盲区。
// 见 docs/spec/2026-07-14-test-tiering-by-speed.md §8。
const VALID_SUFFIXES = [".unit.test.ts", ".it.test.ts", ".http.test.ts", ".pty.test.ts", ".e2e.test.ts"]
const REPO_ROOT = new URL("../..", import.meta.url).pathname

function scan(dir: string): Array<string> {
  const g = new Glob("**/*.test.ts")
  return [...g.scanSync({ cwd: `${REPO_ROOT}/${dir}`, onlyFiles: true })].map((p) => `${dir}/${p}`).sort()
}

describe("test discovery matrix", () => {
  test("every tests/ file carries exactly one authoritative tier suffix", () => {
    const offenders = scan("tests").filter((f) => !VALID_SUFFIXES.some((s) => f.endsWith(s)))
    expect(offenders, `orphan/misnamed test files (no tier suffix — invisible to every test:* script):\n${offenders.join("\n")}`).toEqual([])
  })

  test("no test files live under src/ (root=./tests would hide them from discovery)", () => {
    const srcTests = scan("src")
    expect(srcTests, `src/ test files are undiscoverable under bunfig root=./tests:\n${srcTests.join("\n")}`).toEqual([])
  })

  // 前端（`ui/`、`ui-v4/`）测试是 vitest/Playwright 套件，**必须显式单独触发**
  // （`test:ui` / `test:ui-v4` / `test:e2e-ui`），不得被任何后端档位脚本聚合进去。
  // 用户 2026-07-27 决定，推翻 spec 2026-07-14 §4「把 test:ui-v4 补进聚合门」。
  // 守卫理由：聚合是一行 `&&` 就能悄悄加回来的改动，而后果（跑后端测试却启动前端
  // 工具链、失败原因跨栈）只有在别人踩到时才发现。
  test("no backend tier script pulls in a frontend suite", async () => {
    const scripts = ((await Bun.file(`${REPO_ROOT}/package.json`).json()) as { scripts: Record<string, string> }).scripts
    const FRONTEND = ["test:ui", "test:ui-v4", "test:e2e-ui", "build:ui", "build:ui-v4"]
    const offenders = Object.entries(scripts)
      .filter(([name]) => name === "test" || name.startsWith("test:"))
      .filter(([name]) => !FRONTEND.some((f) => name === f || name.startsWith(`${f}:`)))
      .filter(([, body]) => FRONTEND.some((f) => new RegExp(String.raw`\b${f}\b`).test(body)))
      .map(([name, body]) => `${name}: ${body}`)
    expect(offenders, `backend test script(s) invoke a frontend suite — frontend tests must be run explicitly:\n${offenders.join("\n")}`).toEqual([])
  })

  // `test:perf` names its files literally instead of globbing, which reopens exactly the orphan
  // blind spot this file exists to close — and in a MORE hidden form than an untiered file: a
  // perf-gated case still carries a tier suffix and still shows up in the discovery baseline as an
  // allow-listed skip, so it looks supervised while nothing runs it. Tie the two sides together:
  // the files that opt into the perf gate must be exactly the files the script runs.
  //
  // BOUNDARY: this recognises the LITERAL string `RUN_PERF_TESTS` only. A gate opened through a
  // different variable name, or through an indirection like `env[NAME]`, is invisible to it.
  const PERF_ENV = "RUN_PERF_TESTS"
  const perfGatedFiles = async (root: string): Promise<Array<string>> => {
    const found: Array<string> = []
    const glob = new Glob("**/*.test.ts")
    for (const relative of [...glob.scanSync({ cwd: `${root}/tests`, onlyFiles: true })].sort()) {
      if (relative.endsWith("test-discovery-matrix.unit.test.ts")) continue // this guard names the var itself
      if ((await Bun.file(`${root}/tests/${relative}`).text()).includes(PERF_ENV)) found.push(`tests/${relative}`)
    }
    return found.sort()
  }

  test("every perf-gated test file is named by the test:perf script", async () => {
    const scripts = ((await Bun.file(`${REPO_ROOT}/package.json`).json()) as { scripts: Record<string, string> }).scripts
    const scriptFiles = [...(scripts["test:perf"] ?? "").matchAll(/tests\/\S+?\.(?:unit|it|http|pty|e2e)\.test\.ts/g)].map((match) => match[0]).sort()
    const gated = await perfGatedFiles(REPO_ROOT)
    expect(
      gated,
      `perf-gated files and the test:perf script disagree — a gated case nobody runs still shows up as an allow-listed skip, so it looks supervised.\ngated: ${gated.join(", ")}\nscript: ${scriptFiles.join(", ")}`,
    ).toEqual(scriptFiles)
    // The comparison only means something if the scan found anything at all.
    expect(gated.length).toBeGreaterThan(0)
  })

  test("the perf-gate scan notices a file the script does not name (positive control)", async () => {
    // Planted in a throwaway tree, NEVER under the real `tests/`. Writing a real file here would be
    // visible to any concurrently running full suite: capture-entry-evidence compares the discovered
    // file set against a frozen count, so a peer run landing inside the write/delete window would
    // fail with "discovery baseline differs from entry tree" pointing at a file that no longer
    // exists — a false red on the gate we are trying to make trustworthy.
    const tmp = await Bun.$`mktemp -d`.text().then((s) => s.trim())
    try {
      await Bun.write(`${tmp}/tests/infra/planted.unit.test.ts`, `// ${PERF_ENV}\n`)
      await Bun.write(`${tmp}/tests/infra/unrelated.unit.test.ts`, `// nothing to see here\n`)
      const found = await perfGatedFiles(tmp)
      expect(found).toEqual(["tests/infra/planted.unit.test.ts"])
    } finally {
      await Bun.$`rm -rf ${tmp}`.quiet()
    }
  })
})

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
})

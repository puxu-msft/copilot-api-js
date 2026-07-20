import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

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
})

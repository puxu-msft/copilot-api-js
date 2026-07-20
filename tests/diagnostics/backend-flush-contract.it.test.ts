import {
  //
  expect,
  test,
} from "bun:test"
import path from "node:path"

interface ProbeResult {
  first: { queuedBytes: number; fileBytes: number }
  second: { queuedBytes: number; fileBytes: number }
  totalBytes: number
}

for (const runtime of ["bun", "node"] as const) {
  test(`${runtime}: pinned SonicBoom flush callback can precede a sub-minLength tail`, () => {
    const fixture = path.join(import.meta.dir, "fixtures", "sonic-boom-flush-contract.mjs")
    const process = Bun.spawnSync([runtime, fixture], { cwd: path.resolve(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" })
    const stderr = new TextDecoder().decode(process.stderr)
    expect(process.exitCode, stderr).toBe(0)
    const result = JSON.parse(new TextDecoder().decode(process.stdout)) as ProbeResult

    // Positive control for the third-party seam. If a dependency upgrade fixes
    // this behavior, this test must force an explicit re-evaluation of the
    // adapter rather than silently turning the regression test into a false green.
    expect(result.first).toEqual({ queuedBytes: 4, fileBytes: result.totalBytes - 4 })
    expect(result.second).toEqual({ queuedBytes: 0, fileBytes: result.totalBytes })
  })
}

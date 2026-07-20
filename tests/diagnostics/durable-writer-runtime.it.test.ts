import {
  //
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

for (const runtime of ["bun", "node"] as const) {
  test(`${runtime}: project DurableFileWriter drains and fsyncs the real backend`, async () => {
    const fixture = path.join(import.meta.dir, "fixtures", "durable-writer-runtime.ts")
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "durable-writer-node-bundle-"))
    try {
      let executable = fixture
      if (runtime === "node") {
        const build = await Bun.build({ entrypoints: [fixture], outdir: directory, target: "node", format: "esm" })
        expect(build.success, build.logs.map(String).join("\n")).toBe(true)
        executable = build.outputs[0].path
      }
      const process = Bun.spawnSync([runtime, executable], { cwd: path.resolve(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" })
      const stderr = new TextDecoder().decode(process.stderr)
      expect(process.exitCode, stderr).toBe(0)
      expect(JSON.parse(new TextDecoder().decode(process.stdout))).toEqual({
        durableBytes: 20_004,
        expectedDurableBytes: 20_004,
        state: "closed",
        queuedBytes: 0,
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}

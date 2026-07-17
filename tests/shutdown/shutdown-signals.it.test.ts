import {
  //
  expect,
  test,
} from "bun:test"

test("real foreground SIGINT: first starts graceful shutdown, second exits immediately", () => {
  const proc = Bun.spawnSync(["python3", "tests/shutdown/fixtures/two_signal_pty.py"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new TextDecoder().decode(proc.stderr)
  expect(proc.exitCode, stderr).toBe(0)

  const result = JSON.parse(new TextDecoder().decode(proc.stdout)) as { firstAlive: boolean; exitCode: number; output: string }
  expect(result.firstAlive).toBe(true)
  expect(result.exitCode).toBe(130)
  expect(result.output).toContain("graceful shutdown started")
  expect(result.output).toContain("Press Ctrl+C again to exit immediately")
})

test("real TerminalUi raw Ctrl+C restores cooked mode before the second signal", () => {
  const proc = Bun.spawnSync(["python3", "tests/shutdown/fixtures/two_signal_pty.py", "tests/shutdown/fixtures/two-signal-tui-process.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new TextDecoder().decode(proc.stderr)
  expect(proc.exitCode, stderr).toBe(0)

  const result = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
    firstAlive: boolean
    exitCode: number
    canonical: boolean
    echo: boolean
    output: string
  }
  expect(result.firstAlive).toBe(true)
  expect(result.exitCode).toBe(130)
  expect(result.canonical).toBe(true)
  expect(result.echo).toBe(true)
  expect(result.output).toContain("graceful shutdown started")
})

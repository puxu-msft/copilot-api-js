import {
  //
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function diagnosticEventCounts(directory: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".ndjson"))) {
    for (const line of fs.readFileSync(path.join(directory, name), "utf8").split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as { record?: { diagnostic?: { event?: string } } }
      const event = parsed.record?.diagnostic?.event
      if (event) counts.set(event, (counts.get(event) ?? 0) + 1)
    }
  }
  return counts
}

test("real foreground SIGINT exits 0 only after the production diagnostic barrier is durable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-shutdown-pty-"))
  try {
    const proc = Bun.spawnSync(["python3", "tests/shutdown/fixtures/one_signal_diagnostic_pty.py", directory], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new TextDecoder().decode(proc.stderr)
    expect(proc.exitCode, stderr).toBe(0)
    const result = JSON.parse(new TextDecoder().decode(proc.stdout)) as { exitCode: number; output: string }
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("graceful shutdown started")

    const counts = diagnosticEventCounts(directory)
    expect(counts.get("fixture.head")).toBe(1)
    expect(counts.get("fixture.tail")).toBe(1)
    expect(counts.get("shutdown.persistence-ready")).toBe(1)
    expect(counts.get("shutdown_diagnostic_sealing")).toBe(1)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("real foreground SIGINT exits 1 when the production diagnostic barrier has dropped data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-shutdown-failure-pty-"))
  try {
    const proc = Bun.spawnSync(
      ["python3", "tests/shutdown/fixtures/one_signal_diagnostic_pty.py", directory, "tests/shutdown/fixtures/diagnostic-shutdown-failure-process.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    )
    const stderr = new TextDecoder().decode(proc.stderr)
    expect(proc.exitCode, stderr).toBe(0)
    const result = JSON.parse(new TextDecoder().decode(proc.stdout)) as { exitCode: number; output: string }
    expect(result.exitCode, result.output).toBe(1)
    expect(result.output).toContain("Fatal error during shutdown")
    expect(result.output).not.toContain("Shutdown complete")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

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
    cookedBeforeSecondSignal: boolean
    output: string
  }
  expect(result.firstAlive).toBe(true)
  expect(result.cookedBeforeSecondSignal).toBe(true)
  expect(result.exitCode).toBe(130)
  expect(result.canonical).toBe(true)
  expect(result.echo).toBe(true)
  expect(result.output).toContain("graceful shutdown started")
})

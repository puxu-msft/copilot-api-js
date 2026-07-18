import {
  //
  expect,
  test,
} from "bun:test"

test("real PTY job control stops with WIFSTOPPED, resumes raw, and exits cleanly across 8 runs", () => {
  const rounds: Array<Record<string, unknown>> = []
  for (let iteration = 0; iteration < 8; iteration++) {
    const processResult = Bun.spawnSync(["python3", "tests/tui/pty/job_control_pty.py"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
    const stderr = new TextDecoder().decode(processResult.stderr)
    expect(processResult.exitCode, `iteration ${iteration}: ${stderr}`).toBe(0)
    rounds.push(JSON.parse(new TextDecoder().decode(processResult.stdout)) as Record<string, unknown>)
  }
  expect(rounds).toHaveLength(8)
  for (const result of rounds) {
    expect(result).toMatchObject({
      wifstopped: true,
      stopSignal: 20,
      cookedCanonical: true,
      cookedEcho: true,
      resumedRaw: true,
      resumedNoEcho: true,
      exitCode: 0,
    })
  }
})

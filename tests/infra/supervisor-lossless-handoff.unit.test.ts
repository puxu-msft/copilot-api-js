import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const DEPLOY_SCRIPT = path.join(ROOT, "contrib/systemd/copilot-api-deploy.sh")
const PM2_CONFIG = path.join(ROOT, "contrib/pm2/ecosystem.config.cjs")
const cleanup: Array<string> = []

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("lossless supervisor handoff samples", () => {
  test("systemd handoff waits for the old slot to exit without sending SIGTERM via stop", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "systemd-handoff-"))
    cleanup.push(directory)
    const calls = path.join(directory, "calls.log")
    const state = path.join(directory, "state")
    const fake = path.join(directory, "systemctl")
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_FILE"
case "$1" in
  is-active)
    if [[ "$*" == *"copilot-api@a"* ]]; then
      if [[ ! -f "$STATE_FILE" ]]; then exit 0; fi
      count=$(cat "$STATE_FILE")
      if (( count < 2 )); then printf '%s' $((count + 1)) > "$STATE_FILE"; exit 0; fi
      exit 3
    fi
    exit 3
    ;;
  kill) printf '0' > "$STATE_FILE" ;;
  is-failed) exit 1 ;;
  *) ;;
esac
`,
    )
    chmodSync(fake, 0o755)

    const child = Bun.spawn(["bash", DEPLOY_SCRIPT], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        CALLS_FILE: calls,
        STATE_FILE: state,
        DRAIN_POLL_SECONDS: "0",
        DRAIN_WAIT_SECONDS: "5",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)

    const invoked = readFileSync(calls, "utf8").trim().split("\n")
    const killIndex = invoked.indexOf("kill -s SIGUSR2 copilot-api@a")
    const postKillPolls = invoked.slice(killIndex + 1).filter((line) => line === "is-active --quiet copilot-api@a")
    expect(killIndex).toBeGreaterThanOrEqual(0)
    expect(postKillPolls.length).toBeGreaterThanOrEqual(2)
    expect(invoked).not.toContain("stop copilot-api@a")
    expect(invoked).toContain("is-failed --quiet copilot-api@a")
  })

  test("PM2 slots treat a clean handoff exit as stopped", () => {
    const require = createRequire(import.meta.url)
    Reflect.deleteProperty(require.cache, require.resolve(PM2_CONFIG))
    const config = require(PM2_CONFIG) as { apps: Array<{ name: string; stop_exit_codes?: Array<number> }> }

    expect(config.apps.map((app) => ({ name: app.name, stopExitCodes: app.stop_exit_codes }))).toEqual([
      { name: "copilot-api-blue", stopExitCodes: [0] },
      { name: "copilot-api-green", stopExitCodes: [0] },
    ])
  })
})

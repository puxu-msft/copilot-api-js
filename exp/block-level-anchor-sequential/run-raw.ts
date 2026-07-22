import { spawnSync } from "bun"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnProxy, type SpawnedProxy } from "../../tests/e2e-client/harness/spawn-proxy"

const HOOK = "./exp/block-level-anchor-sequential/hook.ts"
const PORT = 41995
const configYaml =
  ["hooks:", `  upstream_module: "${HOOK}"`, "  enabled: true", "anthropic:", "  stream_keepalive_mode: ping", "  protect_streaming_generation: false"].join("\n") + "\n"

let proxy: SpawnedProxy | undefined
try {
  proxy = await spawnProxy({ port: PORT, configYaml })
  const loaded = await proxy.reloadHook()
  if (!loaded.ok) throw new Error("hook load failed: " + loaded.error)

  const home = mkdtempSync(join(tmpdir(), "cli-raw-home-"))
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
  const model = "claude-sonnet-4.6"
  const proc = spawnSync(["claude", "-p", "say hello", "--model", model, "--output-format", "json", "--verbose"], {
    env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: proxy.baseURL, ANTHROPIC_AUTH_TOKEN: "copilot-api", ANTHROPIC_MODEL: model },
    stdout: "pipe", stderr: "pipe", timeout: 45_000,
  })
  const out = proc.stdout.toString()
  console.log("=== RAW claude stdout ===")
  console.log(out.slice(0, 2000))
  console.log("=== contains 'Hello'? ===", out.includes("Hello"))
  console.log("=== contains marker? ===", out.includes("SEQUENTIAL_OK_MARKER"))
} finally {
  proxy?.close()
}

import { driveClaudeCli } from "../../tests/e2e-client/harness/drive-claude-cli"
import { spawnProxy, type SpawnedProxy } from "../../tests/e2e-client/harness/spawn-proxy"

const HOOK = "./exp/block-level-anchor-sequential/idle-hook.ts"
const PORT = 41997
const configYaml =
  ["hooks:", `  upstream_module: "${HOOK}"`, "  enabled: true", "anthropic:", "  stream_keepalive_mode: ping", "  protect_streaming_generation: false"].join("\n") + "\n"

let proxy: SpawnedProxy | undefined
try {
  proxy = await spawnProxy({ port: PORT, configYaml })
  const loaded = await proxy.reloadHook()
  if (!loaded.ok) throw new Error("hook load failed: " + loaded.error)
  console.log("[G2] hook loaded; driving real claude through a >310s idle gap...")
  const t0 = Date.now()
  const r = driveClaudeCli({ baseURL: proxy.baseURL, prompt: "say hello", model: "claude-sonnet-4.6", timeoutMs: 360_000 })
  console.log("[G2] elapsed:", ((Date.now() - t0) / 1000).toFixed(0), "s")
  console.log("[G2] numTurns:", r.numTurns, "stopReason:", r.stopReason, "isError:", r.isError)
  console.log("[G2] result:", JSON.stringify(r.result))
  const pass = r.numTurns === 1 && r.result.includes("IDLE_SURVIVED_MARKER") && !r.isError
  console.log("[G2] VERDICT:", pass ? "PASS (sequential gap keepalive reset the 300s deadline)" : "FAIL (deadline not reset / disconnected during idle)")
} finally {
  proxy?.close()
}

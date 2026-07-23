import { driveClaudeCli } from "../../tests/e2e-client/harness/drive-claude-cli"
import { spawnProxy, type SpawnedProxy } from "../../tests/e2e-client/harness/spawn-proxy"

const HOOK = "./exp/block-level-anchor-sequential/hook.ts"
const PORT = 41991
const configYaml =
  [
    "hooks:",
    `  upstream_module: "${HOOK}"`,
    "  enabled: true",
    "anthropic:",
    "  stream_keepalive_mode: ping", // keep proxy's own anchor reconciliation OFF — test the WIRE as emitted
    "  protect_streaming_generation: false",
  ].join("\n") + "\n"

let proxy: SpawnedProxy | undefined
try {
  proxy = await spawnProxy({ port: PORT, configYaml })
  const loaded = await proxy.reloadHook()
  console.log("hook loaded:", loaded.ok, "exports:", loaded.exports)
  if (!loaded.ok) throw new Error("hook load failed: " + loaded.error)

  const r = driveClaudeCli({ baseURL: proxy.baseURL, prompt: "say hello", model: "claude-sonnet-4.6" })
  console.log("=== RESULT ===")
  console.log("numTurns:", r.numTurns, "(1 = no stall; >1 = agent-loop re-query stall)")
  console.log("stopReason:", r.stopReason)
  console.log("isError:", r.isError)
  console.log("result text:", JSON.stringify(r.result))
  const pass = r.numTurns === 1 && r.result.includes("SEQUENTIAL_OK_MARKER") && !r.isError
  console.log("=== VERDICT:", pass ? "PASS (sequential-anchor is CLI-safe)" : "FAIL", "===")
} finally {
  proxy?.close()
}

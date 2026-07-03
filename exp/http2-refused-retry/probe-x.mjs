// Phase 0 probe v3: CROSS-RUNTIME. The decisive test — does the Bun CLIENT surface
// a REAL peer RST_STREAM(REFUSED) frame the way production does? v2 used Bun-server→
// Bun-client (Bun's server stream.close may not emit a faithful RST frame). Here the
// SERVER runs under Node (emits real RST frames, proven in v2) and the CLIENT can run
// under either runtime, so we can probe Node-server ← Bun-client (mirrors prod:
// Bun-client ← real GHC server).
//
//   Terminal 1 (server, Node):  node exp/http2-refused-retry/probe-x.mjs server
//     → prints PORT=<n>
//   Terminal 2 (client, Bun):   PORT=<n> bun run exp/http2-refused-retry/probe-x.mjs client
//   Terminal 2 (client, Node):  PORT=<n> node exp/http2-refused-retry/probe-x.mjs client
//
// Driver mode (spawns Node server + runs both clients): node/bun probe-x.mjs auto
import http2 from "node:http2"
import { spawn } from "node:child_process"

const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node"
const role = process.argv[2] ?? "auto"
const log = (...a) => console.log(`[${runtime}:${role}]`, ...a)

// Node server: two refusal mechanisms on distinct paths.
//   /close   → stream.close(REFUSED) pre-response (sends real RST_STREAM(REFUSED))
//   /maxcc   → held by maxConcurrentStreams=1; excess streams refused by the peer
function startServer() {
  const server = http2.createServer({ settings: { maxConcurrentStreams: 1 } })
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {})
    const path = headers[":path"] ?? ""
    if (path.startsWith("/close")) stream.close(http2.constants.NGHTTP2_REFUSED_STREAM)
    // /maxcc: hold the one allowed slot open (never respond) so excess streams refuse
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

function openStream(client, path, label) {
  return new Promise((resolve) => {
    const req = client.request({ ":method": "POST", ":path": path })
    let sawResponse = false, sawEnd = false, errInfo = null
    req.on("response", () => (sawResponse = true))
    req.on("error", (err) => (errInfo = { code: err.code, message: err.message }))
    req.on("end", () => (sawEnd = true))
    req.on("close", () => {
      log(`${label}: err=${errInfo ? `${errInfo.code} ${JSON.stringify(errInfo.message)}` : "none"} resp=${sawResponse} end=${sawEnd} rstCode=${req.rstCode}`)
      resolve()
    })
    req.end()
  })
}

async function runClient(port) {
  const client = http2.connect(`http://127.0.0.1:${port}`)
  client.on("error", (e) => log(`session error: ${e.code} ${JSON.stringify(e.message)}`))
  // (A) real RST(REFUSED) from Node server:
  await openStream(client, "/close", "A(real RST close)")
  // (B) MAX_CONCURRENT_STREAMS: open 3 on /maxcc (server holds slot#1) — excess refused?
  await Promise.race([
    Promise.all([openStream(client, "/maxcc", "B#1"), openStream(client, "/maxcc", "B#2"), openStream(client, "/maxcc", "B#3")]),
    new Promise((r) => setTimeout(r, 2000)),
  ])
  log("B done (or 2s timeout → excess streams were locally queued, not refused)")
  client.destroy()
}

if (role === "server") {
  const { port } = await startServer()
  console.log(`PORT=${port}`)
  // keep alive
} else if (role === "client") {
  await runClient(Number(process.env.PORT))
  process.exit(0)
} else {
  // auto: Node server in-process, then run this file as client under BOTH runtimes.
  const { server, port } = await startServer()
  const run = (cmd) =>
    new Promise((resolve) => {
      const p = spawn(cmd, [process.argv[1], "client"], { env: { ...process.env, PORT: String(port) }, stdio: "inherit" })
      p.on("close", resolve)
    })
  log(`server up on ${port}; running Node client then Bun client`)
  await run("node")
  await run("bun")
  server.close()
  process.exit(0)
}

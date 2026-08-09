// Load-bearing check: does undici (Node's fetch, what Claude Code uses) drop a pooled connection when the response carries `Connection: close`?
// Oracle: count server-side TCP connections. If the pool is evicted, request #2 must arrive on a NEW connection.
import http from "node:http"

async function run({ sendClose, label }) {
  let connections = 0
  const server = http.createServer((req, res) => {
    const headers = { "content-type": "application/json" }
    if (sendClose) headers["connection"] = "close"
    res.writeHead(503, headers)
    res.end(JSON.stringify({ error: "shutting down" }))
  })
  server.on("connection", () => {
    connections++
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  for (let i = 0; i < 3; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" })).text()
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 150))
  console.log(`${label}: 3 requests -> ${connections} TCP connection(s)`)
  server.closeAllConnections()
  server.close()
}

await run({ sendClose: false, label: "control (no Connection: close)" })
await run({ sendClose: true, label: "fix     (Connection: close)  " })

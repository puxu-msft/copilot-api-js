// Does Bun.serve honor an app-set `Connection: close` on the response?
// Oracle: raw socket, HTTP/1.1 keep-alive request; if the server closes the socket after responding, we observe EOF ("end") without sending anything else.
import net from "node:net"

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === "/close")
      return Response.json({ error: "shutting down" }, { status: 503, headers: { Connection: "close", "Retry-After": "1" } })
    return Response.json({ ok: true }, { status: 503 })
  },
})
const port = server.port

function probe(path: string): Promise<{ raw: string; closedByServer: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1")
    let raw = ""
    let closed = false
    const timer = setTimeout(() => {
      sock.destroy()
      resolve({ raw, closedByServer: closed })
    }, 1500)
    sock.on("connect", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`))
    sock.on("data", (d) => {
      raw += d.toString()
    })
    sock.on("end", () => {
      closed = true
      clearTimeout(timer)
      resolve({ raw, closedByServer: true })
    })
    sock.on("error", (err) => {
      clearTimeout(timer)
      console.error(`  socket error on ${path}: ${err}`)
      resolve({ raw, closedByServer: closed })
    })
  })
}

for (const [label, path] of [
  ["with Connection: close", "/close"],
  ["without (control)", "/plain"],
] as const) {
  const r = await probe(path)
  const head = r.raw.split("\r\n\r\n")[0].replaceAll("\r\n", " | ")
  console.log(`${label}: serverClosedSocket=${r.closedByServer}`)
  console.log(`   headers: ${head}`)
}
server.stop(true)

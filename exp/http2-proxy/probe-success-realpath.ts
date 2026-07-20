/**
 * Success-path validation through the REAL createSession + awaitH2Handshake.
 * Run: bun exp/http2-proxy/probe-success-realpath.ts
 */
import net from "node:net"

import { initProxy } from "../../src/lib/proxy.ts"
import { upstreamFetch } from "../../src/lib/transport/upstream-fetch.ts"

function startConnectProxy(): Promise<{ port: number; close: () => void }> {
  const proxy = net.createServer((client) => {
    client.once("data", (d) => {
      const line = d.toString("latin1").split("\r\n")[0]
      const target = line.split(" ")[1]
      const [host, port] = target.split(":")
      const up = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        up.pipe(client)
        client.pipe(up)
      })
      up.on("error", () => client.destroy())
    })
  })
  return new Promise((r) => proxy.listen(0, "127.0.0.1", () => r({ port: (proxy.address() as net.AddressInfo).port, close: () => proxy.close() })))
}

async function hit(label: string): Promise<void> {
  try {
    const res = await upstreamFetch("https://api.github.com/zen", { method: "GET", headers: { "user-agent": "probe" } })
    const body = await res.text()
    console.log(`[ ${res.status === 200 && body.length > 0 ? "OK" : "FAIL"} ] ${label}: status=${res.status} bodyLen=${body.length}`)
  } catch (err) {
    console.log(`[FAIL] ${label}: ${(err as Error).message.slice(0, 80)}`)
  }
}

async function main(): Promise<void> {
  console.log(`runtime: Bun ${Bun.version}`)
  // Direct (no proxy) through real createSession + awaitH2Handshake
  initProxy({ fromEnv: false })
  await hit("DIRECT createSession")
  // Through local CONNECT proxy
  const proxy = await startConnectProxy()
  initProxy({ url: `http://127.0.0.1:${proxy.port}`, fromEnv: false })
  await hit("PROXY(CONNECT) createSession")
  proxy.close()
  initProxy({ fromEnv: false })
  setTimeout(() => process.exit(0), 100)
}
void main()

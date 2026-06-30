/**
 * Concurrent-abort probe (exp/http2-proxy): two requests share one slow session
 * connect; one aborts mid-connect. Expect: the aborted one rejects promptly, the
 * other still succeeds, process survives.
 *
 * Run: bun exp/http2-proxy/probe-abort.ts
 */
import net from "node:net"

import { initProxy } from "../../src/lib/proxy.ts"
import { upstreamFetch } from "../../src/lib/transport/upstream-fetch.ts"

let crashed = false
process.on("uncaughtException", (e) => {
  crashed = true
  console.log(`[CRASH] ${(e as Error).message}`)
})
process.on("unhandledRejection", (e) => {
  crashed = true
  console.log(`[CRASH] unhandledRejection: ${String(e)}`)
})

// CONNECT proxy that delays establishing the tunnel by `delayMs` (slow connect).
function startSlowProxy(delayMs: number): Promise<{ port: number; close: () => void }> {
  const proxy = net.createServer((client) => {
    client.once("data", (d) => {
      const target = d.toString("latin1").split("\r\n")[0].split(" ")[1]
      const [host, port] = target.split(":")
      setTimeout(() => {
        const up = net.connect(Number(port), host, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          up.pipe(client)
          client.pipe(up)
        })
        up.on("error", () => client.destroy())
      }, delayMs)
    })
  })
  return new Promise((r) => proxy.listen(0, "127.0.0.1", () => r({ port: (proxy.address() as net.AddressInfo).port, close: () => proxy.close() })))
}

async function main(): Promise<void> {
  console.log(`runtime: Bun ${Bun.version}`)
  const proxy = await startSlowProxy(3000) // 3s tunnel establishment
  initProxy({ url: `http://127.0.0.1:${proxy.port}`, fromEnv: false })

  const ac = new AbortController()
  const t0 = Date.now()

  // Request A: no abort — should succeed after ~3s.
  const a = upstreamFetch("https://api.github.com/zen", { method: "GET", headers: { "user-agent": "probe" } })
    .then(async (res) => `A ok status=${res.status} len=${(await res.text()).length} @${Date.now() - t0}ms`)
    .catch((e) => `A ERR ${(e as Error).message.slice(0, 40)} @${Date.now() - t0}ms`)

  // Request B: same origin (shares A's connect), aborts at 500ms — should reject promptly.
  const b = upstreamFetch("https://api.github.com/zen", { method: "GET", headers: { "user-agent": "probe" }, signal: ac.signal })
    .then((res) => `B ok status=${res.status} @${Date.now() - t0}ms`)
    .catch((e) => `B ${(e as Error).name === "AbortError" ? "aborted" : "ERR " + (e as Error).message.slice(0, 40)} @${Date.now() - t0}ms`)

  setTimeout(() => ac.abort(), 500)

  console.log(await b) // expect: B aborted @~500ms
  console.log(await a) // expect: A ok @~3000ms
  await new Promise((r) => setTimeout(r, 300))
  console.log(crashed ? "[FAIL] process crashed" : "[ OK ] process survived")
  proxy.close()
  initProxy({ fromEnv: false })
  setTimeout(() => process.exit(0), 100)
}
void main()

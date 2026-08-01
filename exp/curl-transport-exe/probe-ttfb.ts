import http2 from "node:http2"
import tls from "node:tls"

import { runCurl, summarize, text } from "./lib"

const target = process.argv[2] ?? "https://api.github.com/meta"
const u = new URL(target)
const rounds = 20
const curlRows = []
for (let i = 0; i < rounds; i++) {
  const r = await runCurl(["-sS", "--http2", "-o", "/dev/null", "-w", "%{time_starttransfer} %{time_namelookup} %{time_connect} %{time_appconnect} %{http_version}", target])
  const [ttfb, dns, connect, tlsTime, version] = text(r.stdout).trim().split(/\s+/)
  curlRows.push({ i, exit: r.exit, ttfbMs: Number(ttfb) * 1000, dnsMs: Number(dns) * 1000, connectMs: Number(connect) * 1000, tlsMs: Number(tlsTime) * 1000, version, wallMs: r.ms, stderr: text(r.stderr) })
}

const socket = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, ALPNProtocols: ["h2"] })
await new Promise<void>((resolve, reject) => {
  socket.once("secureConnect", resolve)
  socket.once("error", reject)
})
const session = http2.connect(u.origin, { createConnection: () => socket })
await new Promise<void>((resolve, reject) => {
  session.once("connect", resolve)
  session.once("error", reject)
})
const pooledRows = []
for (let i = 0; i < rounds; i++) {
  const start = performance.now()
  const req = session.request({ ":method": "GET", ":path": `${u.pathname}${u.search}`, "user-agent": "curl-transport-poc", accept: "*/*" })
  let ttfbMs = Number.NaN
  req.once("response", () => {
    ttfbMs = performance.now() - start
  })
  req.resume()
  req.end()
  await new Promise<void>((resolve, reject) => {
    req.once("end", resolve)
    req.once("error", reject)
  })
  pooledRows.push({ i, ttfbMs })
}
session.close()

const curlValues = curlRows.map((x) => x.ttfbMs)
const pooledValues = pooledRows.map((x) => x.ttfbMs)
const curlSummary = summarize(curlValues)
const pooledSummary = summarize(pooledValues)
console.log(JSON.stringify({
  target,
  curl: { summary: curlSummary, rows: curlRows },
  pooledNodeHttp2: { summary: pooledSummary, rows: pooledRows },
  delta: { medianMs: curlSummary.median - pooledSummary.median, p95Ms: curlSummary.p95 - pooledSummary.p95 },
}))

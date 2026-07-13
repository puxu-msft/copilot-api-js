// Faithful repro of the 8-concurrent incident: N concurrent http2Fetch to ONE
// silent origin sharing a pooled h2 session, server maxConcurrentStreams low so
// excess streams QUEUE. One request carries the responseHeaderTimeout signal.
// Does it abort at the timeout, or hang behind the queue (incident 691s)?
import http2 from "node:http2"
import fs from "node:fs"
import { http2Fetch } from "../../src/lib/transport/http2-client.ts"
import { combineAbortSignals } from "../../src/lib/stream.ts"
import { createResponseHeaderTimeoutSignal } from "../../src/lib/fetch-utils.ts"
import { setTimeoutConfig } from "../../src/lib/state.ts"

const dir = new URL(".", import.meta.url).pathname
const server = http2.createSecureServer({ key: fs.readFileSync(dir+"key.pem"), cert: fs.readFileSync(dir+"cert.pem"), ALPNProtocols:["h2"], settings:{ maxConcurrentStreams: 2 } })
let streamCount = 0
server.on("stream", (s) => { s.on("error",()=>{}); streamCount++; /* SILENT: never respond, occupy slots */ })
await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()))
const port = (server.address() as any).port
console.log(`[probe] silent h2 server maxCC=2 on ${port}`)
setTimeoutConfig({ responseHeaderTimeout: 3 })

const origin = `https://localhost:${port}`
const mk = (i:number, withTimeout:boolean) => {
  const clientAbort = new AbortController(), reaper = new AbortController()
  const sig = combineAbortSignals(withTimeout ? createResponseHeaderTimeoutSignal() : undefined, undefined, clientAbort.signal, reaper.signal)
  const t0 = Date.now()
  return http2Fetch(new URL(`${origin}/v1/messages?i=${i}`), { method:"POST", headers:{"content-type":"application/json"}, body:"{}", signal: sig })
    .then((r)=>console.log(`[probe] #${i} response ${r.status} @${Date.now()-t0}ms`))
    .catch((e:any)=>console.log(`[probe] #${i} threw @${Date.now()-t0}ms: ${e?.name} ${e?.code??""} ${JSON.stringify(e?.message)}`))
}
// 6 concurrent (like the incident's 8). #0..#3 occupy+queue (no timeout). #4,#5 carry timeout=3s.
const all = [mk(0,false),mk(1,false),mk(2,false),mk(3,false),mk(4,true),mk(5,true)]
await Promise.race([Promise.all(all), new Promise((r)=>setTimeout(r,10000))])
console.log(`[probe] server saw ${streamCount} streams`)
console.log(`[probe] === VERDICT: #4/#5 abort ~3000ms = works even when queued; hang past 3s = BUG (queued stream ignores timeout) ===`)
server.close(); process.exit(0)

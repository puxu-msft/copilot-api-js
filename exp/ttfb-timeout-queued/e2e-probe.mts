// END-TO-END faithful reproduction: real http2Fetch + real combineAbortSignals +
// real createResponseHeaderTimeoutSignal, driven exactly like send.ts:111 against
// a silent TLS h2 upstream. Question: does responseHeaderTimeout actually abort the
// pre-response wait on the production node:http2 hot path?
import http2 from "node:http2"
import fs from "node:fs"

import { http2Fetch } from "../../src/lib/transport/http2-client.ts"
import { combineAbortSignals } from "../../src/lib/stream.ts"
import { createResponseHeaderTimeoutSignal } from "../../src/lib/fetch-utils.ts"
import { setTimeoutConfig } from "../../src/lib/state.ts"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0" // accept self-signed for the probe

const dir = new URL(".", import.meta.url).pathname
const key = fs.readFileSync(dir + "key.pem")
const cert = fs.readFileSync(dir + "cert.pem")

const server = http2.createSecureServer({ key, cert, ALPNProtocols: ["h2"] })
server.on("stream", (stream) => { stream.on("error", () => {}) /* SILENT: never respond */ })
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
const port = (server.address() as any).port
console.log(`[probe] silent h2 server on ${port}`)

// Set responseHeaderTimeout = 2s (prod is 300s; scaled for the probe).
setTimeoutConfig({ responseHeaderTimeout: 2 })

// Reproduce send.ts:111 EXACTLY (streaming path → shutdown arg undefined).
const clientAbort = new AbortController()
const reaper = new AbortController()
const fetchSignal = combineAbortSignals(createResponseHeaderTimeoutSignal(), undefined, clientAbort.signal, reaper.signal)
console.log(`[probe] fetchSignal built; responseHeaderTimeout=2s; waiting...`)

const t0 = Date.now()
try {
  const resp = await http2Fetch(new URL(`https://localhost:${port}/v1/messages`), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: fetchSignal,
  })
  console.log(`[probe] UNEXPECTED response status=${resp.status} after ${Date.now()-t0}ms`)
} catch (e: any) {
  console.log(`[probe] threw after ${Date.now()-t0}ms: ${e?.name} ${e?.code ?? ""} ${JSON.stringify(e?.message)}`)
}
console.log(`[probe] === VERDICT: abort at ~2000ms = TTFB timeout WORKS; hang to ~8s watchdog = BUG reproduced ===`)
server.close(); process.exit(0)

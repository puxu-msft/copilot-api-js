// Reproduce the incident: does the responseHeaderTimeout AbortSignal actually
// terminate an h2 request that is LOCALLY QUEUED behind maxConcurrentStreams?
// Faithfully mirrors runHttp2Fetch's promise+abort structure (http2-client.ts:386-410):
//   const req = session.request(headers)
//   const onPreResponseAbort = () => { req.close(NGHTTP2_CANCEL); reject(abortError()) }
//   signal.addEventListener("abort", onPreResponseAbort, { once:true })
//   req.once("response", ...)
// Server: maxConcurrentStreams=1, holds slot#1 open forever (never responds) →
// simulates GHC's 691s pre-response silence while at the concurrency cap.
import http2 from "node:http2"

const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node"
const log = (...a) => console.log(`[${runtime}]`, ...a)

function startServer() {
  const server = http2.createServer({ settings: { maxConcurrentStreams: 1 } })
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    // Hold every stream open, never respond (silent upstream). With maxCC=1 the
    // 2nd+ client streams are locally queued until slot#1 frees (which never happens).
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

// Faithful replica of runHttp2Fetch's request+abort wiring.
function fetchLikeProd(session, path, signal, label) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    if (signal?.aborted) { log(`${label}: pre-aborted`); return resolve() }
    const req = session.request({ ":method": "POST", ":path": path })
    let settled = false
    const done = (how) => { if (settled) return; settled = true; log(`${label}: ${how} after ${Date.now()-t0}ms`); resolve() }
    const onPreResponseAbort = () => { req.close(http2.constants.NGHTTP2_CANCEL); done("ABORTED (signal fired, req.close)") }
    signal?.addEventListener("abort", onPreResponseAbort, { once: true })
    req.once("response", () => { signal?.removeEventListener("abort", onPreResponseAbort); done("got response headers") })
    req.once("error", (e) => done(`error ${e.code}`))
    req.once("close", () => done(`closed rst=${req.rstCode}`))
    req.end()
  })
}

const { server, port } = await startServer()
log(`server up maxCC=1 on ${port}`)
const session = http2.connect(`http://127.0.0.1:${port}`)
session.on("error", (e) => log(`session err ${e.code}`))

// slot#1: occupy the only concurrent slot, no timeout — held forever
const held = fetchLikeProd(session, "/held", undefined, "slot#1(held,no-signal)")
// slot#2: QUEUED behind slot#1. Wire a 2s responseHeaderTimeout signal (prod: 300s).
const TIMEOUT_MS = 2000
const sig = AbortSignal.timeout(TIMEOUT_MS)
const queued = fetchLikeProd(session, "/queued", sig, `slot#2(queued, timeout=${TIMEOUT_MS}ms)`)

// Observe for 6s: does slot#2 abort at ~2s, or hang past the timeout?
await Promise.race([queued, new Promise((r) => setTimeout(r, 6000))])
log("=== VERDICT: if slot#2 shows no ABORTED line by ~2s, the timeout FAILED to terminate a queued stream (H1 confirmed) ===")
session.destroy(); server.close(); process.exit(0)

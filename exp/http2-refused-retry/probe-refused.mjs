// Phase 0 probe v2: find how the h2 CLIENT (Bun vs Node) surfaces a peer refusing
// a stream, using TWO realistic mechanisms:
//   (A) server calls stream.close(NGHTTP2_REFUSED_STREAM) pre-response
//   (B) server advertises MAX_CONCURRENT_STREAMS=1 and stalls the first stream,
//       so excess concurrent streams get refused (the realistic GHC/edge case).
// v1 crashed because the SERVER stream 'error' was unhandled; here we swallow it
// and focus on what the CLIENT req sees (error vs clean end + rstCode).
//
// Run: bun run exp/http2-refused-retry/probe-refused.mjs
//      node exp/http2-refused-retry/probe-refused.mjs
import http2 from "node:http2"

const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node"
const log = (...a) => console.log(`[${runtime}]`, ...a)

function observeClientStream(client, label) {
  return new Promise((resolve) => {
    const req = client.request({ ":method": "POST", ":path": "/v1/messages" })
    let sawResponse = false
    let sawEnd = false
    let errInfo = null
    req.on("response", () => {
      sawResponse = true
    })
    req.on("error", (err) => {
      errInfo = { code: err.code, message: err.message }
    })
    req.on("end", () => {
      sawEnd = true
    })
    req.on("close", () => {
      log(`${label}: err=${errInfo ? `${errInfo.code} ${JSON.stringify(errInfo.message)}` : "none"} sawResponse=${sawResponse} sawEnd=${sawEnd} rstCode=${req.rstCode}`)
      resolve()
    })
    req.end()
  })
}

// ---------- (A) server stream.close(REFUSED) pre-response ----------
async function probeA() {
  const server = http2.createServer()
  server.on("stream", (stream) => {
    stream.on("error", () => {}) // swallow server-side error so process doesn't crash
    stream.close(http2.constants.NGHTTP2_REFUSED_STREAM)
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  const client = http2.connect(`http://127.0.0.1:${port}`)
  client.on("error", (e) => log(`A session error: ${e.code} ${JSON.stringify(e.message)}`))
  await observeClientStream(client, "A(stream.close REFUSED)")
  client.close()
  server.close()
}

// ---------- (B) MAX_CONCURRENT_STREAMS=1, stall first, open 3 ----------
async function probeB() {
  const server = http2.createServer({ settings: { maxConcurrentStreams: 1 } })
  const open = []
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    open.push(stream) // stall: never respond, hold the single allowed slot
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  const client = http2.connect(`http://127.0.0.1:${port}`)
  client.on("error", (e) => log(`B session error: ${e.code} ${JSON.stringify(e.message)}`))
  client.on("remoteSettings", (s) => log(`B remoteSettings maxConcurrentStreams=${s.maxConcurrentStreams}`))
  // open 3 concurrent streams; server allows only 1 → excess should be refused
  await Promise.all([
    observeClientStream(client, "B stream#1"),
    observeClientStream(client, "B stream#2"),
    observeClientStream(client, "B stream#3"),
  ]).catch((e) => log("B promise err", e?.message))
  // give it a moment then tear down (stalled streams won't close on their own)
  setTimeout(() => {
    client.destroy()
    server.close()
  }, 500)
}

log("=== probe A: stream.close(REFUSED) pre-response ===")
await probeA()
log("=== probe B: MAX_CONCURRENT_STREAMS=1 excess ===")
await probeB()

// Arbitration oracle: does h2 RST_STREAM detection depend on Content-Length?
//
// The two curl PoCs disagreed on whether a mid-body RST_STREAM is detectable.
// Their oracles differed in ONE variable: exp/curl-transport-exe/oracle.mjs sends
// no content-length on /rst, exp/curl-transport-libcurl/oracle.mjs sends
// content-length: 100. This oracle crosses that variable so the disagreement can
// be adjudicated instead of guessed. The SSE endpoint is the one that matters for
// this project — every upstream streaming response is content-length-less SSE.
import * as fs from "node:fs"
import * as http2 from "node:http2"
import * as path from "node:path"

const dir = path.dirname(new URL(import.meta.url).pathname)
const certDir = path.join(dir, "..", "curl-transport-libcurl")

const RST_CODE = http2.constants.NGHTTP2_INTERNAL_ERROR // 2

const server = http2.createSecureServer({
  key: fs.readFileSync(path.join(certDir, "test-key.pem")),
  cert: fs.readFileSync(path.join(certDir, "test-cert.pem")),
})

server.on("session", (s) => s.on("error", () => {}))
server.on("stream", (stream, headers) => {
  // A stream we RST ourselves emits an error event; unhandled it kills the oracle.
  stream.on("error", () => {})
  const p = String(headers[":path"] ?? "")

  // Positive control: no content-length, clean END_STREAM. MUST be reported OK
  // by every client — proves a "detected truncation" elsewhere is discriminating
  // and not just "this client errors on every length-less h2 body".
  if (p === "/ok-nolen") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.end("COMPLETE-NOLEN")
    return
  }
  if (p === "/rst-len") {
    stream.respond({ ":status": 200, "content-type": "text/plain", "content-length": "100" })
    stream.write("PARTIAL-LEN")
    setTimeout(() => stream.close(RST_CODE), 50)
    return
  }
  if (p === "/rst-nolen") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write("PARTIAL-NOLEN")
    setTimeout(() => stream.close(RST_CODE), 50)
    return
  }
  // The shape this project actually runs: SSE, no content-length, cut mid-stream
  // without the application-layer terminator (no message_stop / [DONE]).
  if (p === "/rst-sse") {
    stream.respond({ ":status": 200, "content-type": "text/event-stream" })
    stream.write("event: message_start\ndata: {}\n\n")
    stream.write("event: content_block_delta\ndata: {}\n\n")
    setTimeout(() => stream.close(RST_CODE), 50)
    return
  }
  stream.respond({ ":status": 404 })
  stream.end("nope")
})

server.listen(0, "127.0.0.1", () => {
  const addr = server.address()
  const port = typeof addr === "object" && addr !== null ? addr.port : 0
  process.stdout.write(JSON.stringify({ ready: true, port }) + "\n")
})

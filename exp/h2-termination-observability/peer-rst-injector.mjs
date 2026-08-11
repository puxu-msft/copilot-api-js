// Decisive experiment: inject a protocol-exact peer RST_STREAM(CANCEL) mid-body and record what the node:http2 CLIENT reports, under Bun vs Node.
//
// Why injection rather than a server call: frame-oracle.mjs showed that `serverStream.close(NGHTTP2_CANCEL)` — the spelling the frozen A4 acceptance recipe prescribes — does NOT put an RST_STREAM on the wire at all when the stream still has an open writable side. It sends `DATA[END_STREAM]` instead. So any test built on that spelling measures nothing about peer cancel, and would "prove" peer CANCEL is unobservable while never having sent one.
// A TCP-level injector sidesteps every server-side quirk: it writes the 9-byte frame header plus a 4-byte error code straight at the client, which is by definition what a hostile/aborting peer does.
//
// Run:  bun exp/h2-termination-observability/peer-rst-injector.mjs
//       node exp/h2-termination-observability/peer-rst-injector.mjs

import net from "node:net"
import http2 from "node:http2"

const { NGHTTP2_CANCEL, NGHTTP2_INTERNAL_ERROR, NGHTTP2_REFUSED_STREAM } = http2.constants
const RUNTIME = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`

/** Build a raw HTTP/2 RST_STREAM frame: 9-byte header (length=4, type=0x3, flags=0) + 4-byte error code. */
function rstStreamFrame(streamId, errorCode) {
  const frame = Buffer.alloc(13)
  frame.writeUIntBE(4, 0, 3) // payload length
  frame[3] = 0x3 // type = RST_STREAM
  frame[4] = 0x0 // flags
  frame.writeUInt32BE(streamId & 0x7fffffff, 5)
  frame.writeUInt32BE(errorCode, 9)
  return frame
}

function startServer() {
  return new Promise((resolve) => {
    const server = http2.createServer()
    server.on("stream", (stream) => {
      stream.on("error", () => {})
      stream.respond({ ":status": 200, "content-type": "text/event-stream" })
      stream.write("chunk-one\n")
      // Deliberately never end: the injector, not the server, terminates this stream.
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

/**
 * Relay TCP both ways. When the first non-empty server→client DATA frame has been forwarded,
 * fire `errorCode` at the client as a genuine RST_STREAM frame, then stop relaying that direction.
 */
function startInjectingProxy(upstreamPort, errorCode) {
  return new Promise((resolve) => {
    const proxy = net.createServer((downstream) => {
      const upstream = net.connect(upstreamPort, "127.0.0.1")
      let injected = false
      let buf = Buffer.alloc(0)

      downstream.on("data", (c) => upstream.write(c))
      upstream.on("data", (c) => {
        if (injected) return // the stream is dead; anything further would be a protocol error
        downstream.write(c)

        buf = Buffer.concat([buf, c])
        while (buf.length >= 9) {
          const length = buf.readUIntBE(0, 3)
          if (buf.length < 9 + length) break
          const type = buf[3]
          const streamId = buf.readUInt32BE(5) & 0x7fffffff
          if (type === 0x0 && length > 0 && streamId > 0 && !injected) {
            injected = true
            // errorCode === null means "no frame at all": rip the TCP connection out from under the client.
            if (errorCode === null) {
              setTimeout(() => downstream.destroy(), 10)
            } else {
              downstream.write(rstStreamFrame(streamId, errorCode))
            }
          }
          buf = buf.subarray(9 + length)
        }
      })

      const bye = () => {
        downstream.destroy()
        upstream.destroy()
      }
      downstream.on("close", bye)
      upstream.on("close", bye)
      downstream.on("error", () => {})
      upstream.on("error", () => {})
    })
    proxy.listen(0, "127.0.0.1", () => resolve({ proxy, port: proxy.address().port }))
  })
}

async function inject(errorCode, label) {
  const { server, port: serverPort } = await startServer()
  const { proxy, port: proxyPort } = await startInjectingProxy(serverPort, errorCode)

  const events = []
  const errors = []
  let bytes = 0
  const session = http2.connect(`http://127.0.0.1:${proxyPort}`)
  session.on("error", (err) => events.push(`session:error(${err.code ?? err.message})`))
  session.on("goaway", (code) => events.push(`session:goaway(${code})`))

  const req = session.request({ ":path": "/probe", ":method": "GET" })
  let rstCodeAtClose = null

  await new Promise((resolve) => {
    req.on("response", (h) => events.push(`response(:status=${h[":status"]})`))
    req.on("data", (chunk) => {
      bytes += chunk.length
      if (!events.includes("data")) events.push("data")
    })
    req.on("aborted", () => events.push("aborted"))
    req.on("frameError", (t, c) => events.push(`frameError(type=${t},code=${c})`))
    req.on("end", () => events.push("end"))
    req.on("error", (err) => {
      events.push(`error(${err.code ?? err.name})`)
      errors.push({ code: err.code, message: err.message })
    })
    req.on("close", () => {
      rstCodeAtClose = req.rstCode
      events.push("close")
      setTimeout(resolve, 80)
    })
    setTimeout(() => {
      events.push("PROBE-TIMEOUT")
      resolve()
    }, 4000)
  })

  const result = {
    label,
    injectedErrorCode: errorCode,
    runtime: RUNTIME,
    sequence: events.join(" → "),
    bytes,
    rstCodeAtClose,
    rstCodeAtSettle: req.rstCode,
    errors,
  }

  try {
    session.destroy()
  } catch {
    /* already gone */
  }
  proxy.close()
  server.close()
  return result
}

const results = {}
for (const [code, label] of [
  [NGHTTP2_CANCEL, "peer RST_STREAM(CANCEL=8) mid-body"],
  [NGHTTP2_INTERNAL_ERROR, "peer RST_STREAM(INTERNAL_ERROR=2) mid-body"],
  [NGHTTP2_REFUSED_STREAM, "peer RST_STREAM(REFUSED_STREAM=7) mid-body"],
  [null, "abrupt TCP drop mid-body (no frame at all)"],
]) {
  const result = await inject(code, label)
  results[label] = result
  process.stdout.write(`\n### ${label}\n${JSON.stringify(result, null, 2)}\n`)
}

process.stdout.write(`\n===== INJECTED PEER RST (${RUNTIME}) =====\n`)
process.stdout.write(`${JSON.stringify({ runtime: RUNTIME, results }, null, 2)}\n`)
process.exit(0)

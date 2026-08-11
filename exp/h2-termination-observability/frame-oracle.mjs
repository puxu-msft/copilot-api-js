// Wire-level oracle for the termination probe.
//
// probe.mjs measures what the node:http2 CLIENT API reports. That is exactly the layer suspected of lying, so a client-side reading cannot confirm its own premise: if the client says "clean end", that is equally consistent with "the peer really ended cleanly" (my scenario is miswritten) and with "the peer sent RST_STREAM and the runtime swallowed it" (the runtime is lossy).
// This proxy sits between client and server as a plain TCP relay and decodes only the 9-byte HTTP/2 frame headers, so it reports which frames actually crossed the wire, independent of either runtime's stream API.
//
// Run:  bun exp/h2-termination-observability/frame-oracle.mjs
//       node exp/h2-termination-observability/frame-oracle.mjs

import net from "node:net"
import http2 from "node:http2"

const { NGHTTP2_CANCEL, NGHTTP2_INTERNAL_ERROR } = http2.constants
const RUNTIME = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`

const FRAME_TYPES = {
  0x0: "DATA",
  0x1: "HEADERS",
  0x2: "PRIORITY",
  0x3: "RST_STREAM",
  0x4: "SETTINGS",
  0x5: "PUSH_PROMISE",
  0x6: "PING",
  0x7: "GOAWAY",
  0x8: "WINDOW_UPDATE",
  0x9: "CONTINUATION",
}

const CLIENT_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")

/** Incremental HTTP/2 frame-header decoder. Only headers are decoded; payloads are skipped except for RST_STREAM/GOAWAY error codes. */
function createFrameDecoder(direction, log) {
  let buf = Buffer.alloc(0)
  let prefaceSkipped = direction !== "client→server"

  return (chunk) => {
    buf = Buffer.concat([buf, chunk])

    if (!prefaceSkipped) {
      if (buf.length < CLIENT_PREFACE.length) return
      if (buf.subarray(0, CLIENT_PREFACE.length).equals(CLIENT_PREFACE)) {
        buf = buf.subarray(CLIENT_PREFACE.length)
      }
      prefaceSkipped = true
    }

    while (buf.length >= 9) {
      const length = buf.readUIntBE(0, 3)
      if (buf.length < 9 + length) return
      const type = buf[3]
      const flags = buf[4]
      const streamId = buf.readUInt32BE(5) & 0x7fffffff
      const payload = buf.subarray(9, 9 + length)

      const name = FRAME_TYPES[type] ?? `UNKNOWN(0x${type.toString(16)})`
      const notes = []
      if (type === 0x0 || type === 0x1) {
        if (flags & 0x1) notes.push("END_STREAM")
        if (type === 0x1 && flags & 0x4) notes.push("END_HEADERS")
        if (type === 0x0) notes.push(`${length}B`)
      }
      if (type === 0x3) notes.push(`errorCode=${payload.readUInt32BE(0)}`)
      if (type === 0x7) {
        notes.push(`lastStreamId=${payload.readUInt32BE(0)}`)
        notes.push(`errorCode=${payload.readUInt32BE(4)}`)
      }
      if (type === 0x4 && flags & 0x1) notes.push("ACK")
      if (type === 0x6 && flags & 0x1) notes.push("ACK")

      // SETTINGS/WINDOW_UPDATE/PING are connection bookkeeping and drown out the signal.
      const boring = type === 0x4 || type === 0x8 || type === 0x6
      if (!boring) {
        log(`${direction} ${name} stream=${streamId}${notes.length ? ` [${notes.join(", ")}]` : ""}`)
      }

      buf = buf.subarray(9 + length)
    }
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http2.createServer()
    server.on("stream", handler)
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

function startProxy(upstreamPort, log) {
  return new Promise((resolve) => {
    const proxy = net.createServer((downstream) => {
      const upstream = net.connect(upstreamPort, "127.0.0.1")
      const decodeUp = createFrameDecoder("client→server", log)
      const decodeDown = createFrameDecoder("server→client", log)

      downstream.on("data", (c) => {
        decodeUp(c)
        upstream.write(c)
      })
      upstream.on("data", (c) => {
        decodeDown(c)
        downstream.write(c)
      })
      const bye = (who) => () => {
        log(`TCP ${who} closed`)
        downstream.destroy()
        upstream.destroy()
      }
      downstream.on("close", bye("client-side"))
      upstream.on("close", bye("server-side"))
      downstream.on("error", () => {})
      upstream.on("error", () => {})
    })
    proxy.listen(0, "127.0.0.1", () => resolve({ proxy, port: proxy.address().port }))
  })
}

async function runScenario({ name, what, handler, onFirstData, waitMs = 1200 }) {
  const frames = []
  const log = (line) => frames.push(line)
  const { server, port: serverPort } = await startServer(handler)
  const { proxy, port: proxyPort } = await startProxy(serverPort, log)

  const session = http2.connect(`http://127.0.0.1:${proxyPort}`)
  session.on("error", () => {})
  const req = session.request({ ":path": "/probe", ":method": "GET" })
  req.on("error", () => {})
  let first = false
  req.on("data", () => {
    if (!first) {
      first = true
      if (onFirstData) onFirstData(req)
    }
  })

  await new Promise((r) => setTimeout(r, waitMs))
  try {
    session.destroy()
  } catch {
    /* already gone */
  }
  proxy.close()
  server.close()

  // Frames the proxy relayed AFTER our own teardown are noise, but the teardown happens last anyway.
  return { name, what, frames }
}

function respondThen(then, { delayMs = 60 } = {}) {
  return (stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200, "content-type": "text/event-stream" })
    stream.write("chunk-one\n")
    setTimeout(() => then(stream), delayMs)
  }
}

const scenarios = [
  {
    name: "A clean-end",
    what: "control: does the last DATA frame carry END_STREAM?",
    handler: (stream) => {
      stream.on("error", () => {})
      stream.respond({ ":status": 200 })
      stream.end("chunk-one\n")
    },
  },
  {
    name: "B peer-RST_STREAM(CANCEL)",
    what: "THE question: does an RST_STREAM(8) frame actually cross the wire, and did DATA carry END_STREAM first?",
    handler: respondThen((s) => s.close(NGHTTP2_CANCEL)),
  },
  {
    name: "C peer-RST_STREAM(INTERNAL_ERROR)",
    what: "same with code 2, to show the code on the wire",
    handler: respondThen((s) => s.close(NGHTTP2_INTERNAL_ERROR)),
  },
  {
    name: "B2 server stream.destroy()",
    what: "alternative spelling: does a bare destroy() emit RST_STREAM mid-body?",
    handler: respondThen((s) => s.destroy()),
  },
  {
    name: "B3 server stream.destroy(new Error())",
    what: "alternative spelling: does destroy(err) emit RST_STREAM, and with which code?",
    handler: respondThen((s) => s.destroy(new Error("boom"))),
  },
  {
    name: "E local-abort",
    what: "our own req.close(CANCEL) — RST should travel client→server",
    handler: respondThen(() => {}, { delayMs: 3000 }),
    onFirstData: (req) => req.close(NGHTTP2_CANCEL),
  },
]

const out = {}
for (const scenario of scenarios) {
  const result = await runScenario(scenario)
  out[result.name] = result.frames
  process.stdout.write(`\n### ${result.name}\n${result.what}\n`)
  for (const frame of result.frames) process.stdout.write(`  ${frame}\n`)
}

process.stdout.write(`\n===== WIRE ORACLE (${RUNTIME}) =====\n`)
process.stdout.write(`${JSON.stringify({ runtime: RUNTIME, frames: out }, null, 2)}\n`)
process.exit(0)

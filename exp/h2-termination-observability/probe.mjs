// Probe: what does a node:http2 CLIENT actually observe for each kind of stream termination, under Bun vs under Node?
//
// Why this exists: tests/transport/http2-client.it.test.ts carries a NOTE claiming that under Bun, EVERY mid-stream termination is delivered to the client as a synthetic clean `response → data → end → close` with rstCode=0 — i.e. a clean server RST_STREAM(CANCEL) and a full connection drop are indistinguishable from a normal end.
// That NOTE cites `exp/upstream-models-hang/`, which does not exist in this repo and never did (`git log --all -- 'exp/upstream-models-hang'` is empty).
// A4 wants History to mechanically tell peer CANCEL apart from local abort, so the claim is load bearing and had to be measured rather than inherited.
//
// Run:  bun exp/h2-termination-observability/probe.mjs
//       node exp/h2-termination-observability/probe.mjs
//
// Each scenario gets a fresh server + fresh session, so no state leaks between them.

import http2 from "node:http2"

const {
  NGHTTP2_CANCEL,
  NGHTTP2_INTERNAL_ERROR,
  NGHTTP2_REFUSED_STREAM,
  NGHTTP2_NO_ERROR,
} = http2.constants

const RUNTIME = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`

/** Serialise what the client saw, in arrival order, so two runtimes can be diffed literally. */
class Observation {
  constructor() {
    this.events = []
    this.bytes = 0
    this.rstCodeAtClose = null
    this.errors = []
    this.sessionEvents = []
  }

  push(name, detail) {
    this.events.push(detail === undefined ? name : `${name}(${detail})`)
  }

  get summary() {
    return {
      runtime: RUNTIME,
      sequence: this.events.join(" → "),
      bytes: this.bytes,
      rstCodeAtClose: this.rstCodeAtClose,
      rstCodeAtSettle: this.rstCodeAtSettle ?? null,
      errors: this.errors,
      sessionEvents: this.sessionEvents.join(" → ") || "(none)",
    }
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http2.createServer()
    const sockets = new Set()
    server.on("connection", (socket) => sockets.add(socket))
    server.on("stream", handler)
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, sockets })
    })
  })
}

/**
 * Drive one request against one server and report exactly what the client stream emitted.
 * `onFirstData` lets a scenario inject a LOCAL action (abort) at a deterministic point.
 */
async function observe({ handler, onFirstData, timeoutMs = 4000 }) {
  const { server, port, sockets } = await startServer(handler)
  const obs = new Observation()
  const session = http2.connect(`http://127.0.0.1:${port}`)
  obs.serverSockets = sockets

  session.on("error", (err) => obs.sessionEvents.push(`error(${err.code ?? err.message})`))
  session.on("goaway", (errorCode, lastStreamID) =>
    obs.sessionEvents.push(`goaway(code=${errorCode},last=${lastStreamID})`),
  )
  session.on("close", () => obs.sessionEvents.push("close"))

  const req = session.request({ ":path": "/probe", ":method": "GET" })
  let sawFirstData = false

  const done = new Promise((resolve) => {
    const finish = () => setTimeout(resolve, 50) // let trailing events land before we read rstCode
    req.on("response", (headers) => obs.push("response", `:status=${headers[":status"]}`))
    req.on("data", (chunk) => {
      obs.bytes += chunk.length
      if (!sawFirstData) {
        sawFirstData = true
        obs.push("data")
        if (onFirstData) onFirstData(req)
      }
    })
    req.on("aborted", () => obs.push("aborted"))
    req.on("frameError", (type, code) => obs.push("frameError", `type=${type},code=${code}`))
    req.on("end", () => obs.push("end"))
    req.on("error", (err) => {
      obs.push("error", err.code ?? err.name)
      obs.errors.push({ code: err.code, name: err.name, message: err.message })
      finish()
    })
    req.on("close", () => {
      obs.rstCodeAtClose = req.rstCode
      obs.push("close")
      finish()
    })
    setTimeout(() => {
      obs.push("PROBE-TIMEOUT")
      resolve()
    }, timeoutMs)
  })

  await done
  obs.rstCodeAtSettle = req.rstCode
  obs.closedAtSettle = req.closed
  try {
    session.destroy()
  } catch {
    /* already gone */
  }
  server.close()
  return obs.summary
}

/** Server helper: send headers + one chunk, then run `then(stream)` once the chunk is on the wire. */
function respondThen(then, { delayMs = 60 } = {}) {
  return (stream) => {
    // The SERVER side emits its own error when it RSTs a stream; without this sink Node aborts the process.
    stream.on("error", () => {})
    stream.session?.on("error", () => {})
    stream.respond({ ":status": 200, "content-type": "text/event-stream" })
    stream.write("chunk-one\n")
    setTimeout(() => then(stream), delayMs)
  }
}

const scenarios = {
  "A clean-end": {
    what: "server responds, writes, ends normally — the control",
    run: () =>
      observe({
        handler: (stream) => {
          stream.respond({ ":status": 200 })
          stream.end("chunk-one\n")
        },
      }),
  },

  "B peer-RST_STREAM(CANCEL)": {
    what: "server sends headers+data, then stream.close(NGHTTP2_CANCEL) — the peer cancel A4 must identify",
    run: () => observe({ handler: respondThen((s) => s.close(NGHTTP2_CANCEL)) }),
  },

  "C peer-RST_STREAM(INTERNAL_ERROR)": {
    what: "same, but a different RST code — does the code survive to the client?",
    run: () => observe({ handler: respondThen((s) => s.close(NGHTTP2_INTERNAL_ERROR)) }),
  },

  "D connection-drop": {
    what: "server destroys the whole H2 session mid-body (no GOAWAY) — must NOT look like a clean end",
    run: () => observe({ handler: respondThen((s) => s.session.destroy()) }),
  },

  "E local-abort": {
    what: "client calls req.close(NGHTTP2_CANCEL) after first data — locally observable by construction",
    run: () =>
      observe({
        handler: respondThen(() => {
          /* server keeps the stream open; the client is the one who quits */
        }, { delayMs: 3000 }),
        onFirstData: (req) => req.close(NGHTTP2_CANCEL),
      }),
  },

  "F goaway-then-destroy": {
    what: "server GOAWAYs the session while the stream is live",
    run: () =>
      observe({
        handler: respondThen((s) => {
          const sess = s.session // Bun nulls stream.session once GOAWAY is queued, so grab it first
          sess.goaway(NGHTTP2_NO_ERROR, s.id - 2)
          setTimeout(() => sess.destroy(), 40)
        }),
      }),
  },

  "G peer-RST_STREAM(REFUSED_STREAM)": {
    what: "RST before any headers — the retryable class",
    run: () =>
      observe({
        handler: (stream) => {
          stream.on("error", () => {})
          stream.close(NGHTTP2_REFUSED_STREAM)
        },
      }),
  },
}

const results = {}
for (const [name, scenario] of Object.entries(scenarios)) {
  process.stdout.write(`\n### ${name}\n${scenario.what}\n`)
  const result = await scenario.run()
  results[name] = result
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

process.stdout.write(`\n===== MACHINE-READABLE (${RUNTIME}) =====\n`)
process.stdout.write(`${JSON.stringify({ runtime: RUNTIME, results }, null, 2)}\n`)
process.exit(0)

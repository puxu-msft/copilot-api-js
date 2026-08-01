#!/usr/bin/env node
import fs from "node:fs"
import http2 from "node:http2"
import https from "node:https"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const host = "127.0.0.1"
const h2Port = Number(process.env.H2_PORT ?? 18443)
const h1Port = Number(process.env.H1_PORT ?? 18444)
const eventLog = process.env.ORACLE_EVENT_LOG
const tls = {
  key: fs.readFileSync(path.join(here, "test-key.pem")),
  cert: fs.readFileSync(path.join(here, "test-cert.pem")),
}

function emit(event) {
  const line = JSON.stringify({ at: Date.now(), ...event })
  console.log(line)
  if (eventLog) fs.appendFileSync(eventLog, `${line}\n`)
}

let nextSessionId = 1
const sessionIds = new WeakMap()
const sockets = new Set()

const h2 = http2.createSecureServer({ ...tls, allowHTTP1: false })
h2.on("session", (session) => {
  const sessionId = nextSessionId++
  sessionIds.set(session, sessionId)
  sockets.add(session.socket)
  emit({ event: "h2-session", sessionId, remotePort: session.socket.remotePort })
  session.on("ping", (payload) => emit({ event: "h2-ping", sessionId, payload: payload.toString("hex") }))
  session.on("close", () => sockets.delete(session.socket))
})
h2.on("stream", (stream, headers) => {
  const requestPath = headers[":path"]
  const sessionId = sessionIds.get(stream.session)
  stream.on("error", (error) => emit({ event: "h2-stream-error", path: requestPath, sessionId, code: error.code, message: error.message }))
  emit({ event: "h2-request", path: requestPath, sessionId })

  if (requestPath === "/stream-trailers") {
    stream.respond({ ":status": 200, "content-type": "text/plain", trailer: "x-oracle-trailer" }, { waitForTrailers: true })
    stream.write("first\n")
    setTimeout(() => stream.write("second\n"), 180)
    setTimeout(() => stream.end("third\n"), 360)
    stream.on("wantTrailers", () => stream.sendTrailers({ "x-oracle-trailer": "trailer-value" }))
    return
  }
  if (requestPath === "/rst") {
    stream.respond({ ":status": 200, "content-type": "text/plain", "content-length": "100" })
    stream.write("partial-rst\n")
    setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 80)
    return
  }
  if (requestPath === "/destroy") {
    stream.respond({ ":status": 200, "content-type": "text/plain", "content-length": "100" })
    stream.write("partial-destroy\n")
    setTimeout(() => stream.session.destroy(), 80)
    return
  }
  if (requestPath === "/hold") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write("held-open\n")
    setTimeout(() => stream.end("done\n"), 1600)
    return
  }
  if (requestPath === "/hold-long") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write("held-open\n")
    setTimeout(() => stream.end("done\n"), 8000)
    return
  }
  stream.respond({ ":status": 200, "content-type": "application/json" })
  stream.end(JSON.stringify({ ok: true, protocol: "h2", sessionId, path: requestPath }))
})
h2.on("sessionError", (error) => emit({ event: "h2-session-error", message: error.message }))
h2.on("error", (error) => emit({ event: "h2-server-error", message: error.message }))

const h1 = https.createServer(tls, (req, res) => {
  emit({ event: "h1-request", path: req.url, remotePort: req.socket.remotePort })
  if (req.url === "/chunk-drop") {
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" })
    res.write("partial-chunk\n")
    setTimeout(() => req.socket.destroy(), 80)
    return
  }
  if (req.url === "/length-drop") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "100" })
    res.write("partial-length\n")
    setTimeout(() => req.socket.destroy(), 80)
    return
  }
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ ok: true, protocol: "h1", remotePort: req.socket.remotePort, path: req.url }))
})
h1.on("connection", (socket) => {
  sockets.add(socket)
  socket.on("close", () => sockets.delete(socket))
})
h1.on("error", (error) => emit({ event: "h1-server-error", message: error.message }))

await Promise.all([
  new Promise((resolve) => h2.listen(h2Port, host, resolve)),
  new Promise((resolve) => h1.listen(h1Port, host, resolve)),
])
emit({ event: "ready", h2Port, h1Port, pid: process.pid })

async function shutdown() {
  for (const socket of sockets) socket.destroy()
  await Promise.all([
    new Promise((resolve) => h2.close(resolve)),
    new Promise((resolve) => h1.close(resolve)),
  ])
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)))
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)))

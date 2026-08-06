import fs from "node:fs"
import http from "node:http"
import http2 from "node:http2"
import net from "node:net"
import tls from "node:tls"

const HOST = "127.0.0.1"
const H1_PORT = 19080
const H2C_PORT = 19081
const HTTP_PROXY_PORT = 19082
const SOCKS_PORT = 19083
const RAW_H1_PORT = 19084
const HTTPS_PORT = 19443
const HTTPS_PROXY_PORT = 19444
const cert = fs.readFileSync(new URL("./test-cert.pem", import.meta.url))
const key = fs.readFileSync(new URL("./test-key.pem", import.meta.url))
const sockets = new Set()

function track(server) {
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  return server
}

function json(res, value) {
  const body = JSON.stringify(value)
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

function handleH1(req, res) {
  const url = new URL(req.url, "http://oracle")
  if (url.pathname === "/ok" || url.pathname === "/headers") {
    res.writeHead(200, { "X-Mixed-Case": "Value", "x-empty-response": "", "content-type": "text/plain" })
    res.end("BODY-OK")
    return
  }
  if (url.pathname === "/trailers") {
    res.writeHead(200, { "content-type": "text/plain", trailer: "x-trailer-one, x-trailer-two" })
    res.write("BODY-H1")
    res.addTrailers({ "x-trailer-one": "one", "x-trailer-two": "two" })
    res.end()
    return
  }
  if (url.pathname === "/hold") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.write("PREFIX")
    return
  }
  if (url.pathname === "/stream") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.write("PREFIX")
    const timer = setInterval(() => res.write("."), 100)
    res.on("close", () => clearInterval(timer))
    return
  }
  if (url.pathname === "/duplex") {
    res.writeHead(200, { "content-type": "application/octet-stream" })
    let bytes = 0
    req.on("data", (chunk) => {
      bytes += chunk.length
      res.write(Buffer.alloc(chunk.length, 0x52))
    })
    req.on("end", () => res.end(`\nRECEIVED=${bytes}\n`))
    return
  }
  if (url.pathname === "/echo") {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      json(res, { bytes: body.length, sha256: BunHash(body), headers: req.headers, rawHeaders: req.rawHeaders })
    })
    return
  }
  res.writeHead(404)
  res.end("not found")
}

function BunHash(buffer) {
  return import.meta.resolve ? createHash(buffer) : createHash(buffer)
}

function createHash(buffer) {
  // Kept dependency-free for Node: crypto is loaded synchronously at module startup below.
  return cryptoHash(buffer)
}

import { createHash as nodeCreateHash } from "node:crypto"
function cryptoHash(buffer) {
  return nodeCreateHash("sha256").update(buffer).digest("hex")
}

function handleH2(stream, headers) {
  stream.on("error", (error) => console.log(JSON.stringify({ event: "server-stream-error", code: error.code, message: error.message })))
  const path = String(headers[":path"] ?? "/")
  const url = new URL(path, "http://oracle")
  if (url.pathname === "/ok" || url.pathname === "/headers") {
    stream.respond({ ":status": 200, "X-Mixed-Case": "Value", "x-empty-response": "", "content-type": "text/plain" })
    stream.end("BODY-OK")
    return
  }
  if (url.pathname === "/trailers") {
    stream.respond({ ":status": 200, "content-type": "text/plain" }, { waitForTrailers: true })
    stream.on("wantTrailers", () => stream.sendTrailers({ "x-trailer-one": "one", "x-trailer-two": "two" }))
    stream.end("BODY-H2")
    return
  }
  if (url.pathname === "/rst") {
    const code = Number(url.searchParams.get("code") ?? http2.constants.NGHTTP2_CANCEL)
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write(`PARTIAL-H2-RST-${code}`)
    setTimeout(() => stream.close(code), 30)
    return
  }
  if (url.pathname === "/destroy") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write("PARTIAL-H2-DESTROY")
    setTimeout(() => stream.session.destroy(), 30)
    return
  }
  if (url.pathname === "/hold") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write("PREFIX")
    return
  }
  if (url.pathname === "/stream") {
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.write("PREFIX")
    const timer = setInterval(() => stream.write("."), 100)
    stream.on("close", () => clearInterval(timer))
    return
  }
  if (url.pathname === "/echo") {
    const chunks = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.on("end", () => {
      const body = Buffer.concat(chunks)
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ bytes: body.length, sha256: cryptoHash(body), headers }))
    })
    return
  }
  stream.respond({ ":status": 404 })
  stream.end("not found")
}

function tunnel(client, host, port, initial = Buffer.alloc(0)) {
  const upstream = net.connect(port, host, () => {
    if (initial.length > 0) upstream.write(initial)
    client.pipe(upstream).pipe(client)
  })
  upstream.on("error", () => client.destroy())
  client.on("error", () => upstream.destroy())
}

function parseAuthority(authority) {
  const i = authority.lastIndexOf(":")
  return { host: authority.slice(0, i), port: Number(authority.slice(i + 1)) }
}

const h1 = track(http.createServer(handleH1))
const h2c = track(http2.createServer())
h2c.on("stream", handleH2)
h2c.on("session", (session) => session.on("ping", (payload) => console.log(JSON.stringify({ event: "h2-ping", server: "h2c", payload: payload.toString("hex"), at: Date.now() }))))
const httpsOrigin = track(http2.createSecureServer({ key, cert, allowHTTP1: true }))
httpsOrigin.on("stream", handleH2)
httpsOrigin.on("session", (session) => session.on("ping", (payload) => console.log(JSON.stringify({ event: "h2-ping", server: "https", payload: payload.toString("hex"), at: Date.now() }))))
httpsOrigin.on("request", (req, res) => {
  if (req.httpVersionMajor === 1) handleH1(req, res)
})

const rawH1 = track(net.createServer((socket) => {
  let request = ""
  socket.on("data", (chunk) => {
    request += chunk.toString("latin1")
    if (!request.includes("\r\n\r\n")) return
    if (request.includes("GET /content-length")) {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: text/plain\r\n\r\nPARTIAL-H1-CONTENT-LENGTH")
    } else if (request.includes("GET /chunk-incomplete")) {
      socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n10\r\nPARTIAL-CHUNK\r\n")
    } else if (request.includes("GET /clean")) {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nCOMPLETE")
    } else {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
    }
  })
}))

const httpProxy = track(http.createServer((req, res) => {
  res.writeHead(502)
  res.end("CONNECT required")
}))
httpProxy.on("connect", (req, client, head) => {
  const { host, port } = parseAuthority(req.url)
  client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: oracle\r\n\r\n")
  tunnel(client, host, port, head)
})

function attachHttpsProxy(server) {
  server.on("connect", (req, client, head) => {
    const { host, port } = parseAuthority(req.url)
    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: oracle-tls\r\n\r\n")
    tunnel(client, host, port, head)
  })
  server.on("stream", (stream, headers) => {
    if (headers[":method"] !== "CONNECT") {
      stream.respond({ ":status": 405 })
      stream.end()
      return
    }
    const { host, port } = parseAuthority(String(headers[":authority"]))
    const upstream = net.connect(port, host, () => {
      stream.respond({ ":status": 200 })
      stream.pipe(upstream).pipe(stream)
    })
    upstream.on("error", () => stream.close(http2.constants.NGHTTP2_CONNECT_ERROR))
    stream.on("error", () => upstream.destroy())
  })
}
const httpsProxy = track(http2.createSecureServer({ key, cert, allowHTTP1: true }))
attachHttpsProxy(httpsProxy)

const socks = track(net.createServer((socket) => {
  let state = "greeting"
  let buffered = Buffer.alloc(0)
  socket.on("data", onData)
  function onData(chunk) {
    buffered = Buffer.concat([buffered, chunk])
    if (state === "greeting") {
      if (buffered.length < 2 + buffered[1]) return
      buffered = buffered.subarray(2 + buffered[1])
      socket.write(Buffer.from([5, 0]))
      state = "request"
    }
    if (state !== "request" || buffered.length < 4) return
    const version = buffered[0]
    const command = buffered[1]
    const atyp = buffered[3]
    console.log(JSON.stringify({ event: "socks-request", version, command, atyp, bytes: buffered.toString("hex") }))
    let offset = 4
    let host
    if (atyp === 1) {
      if (buffered.length < 10) return
      host = [...buffered.subarray(offset, offset + 4)].join(".")
      offset += 4
    } else if (atyp === 3) {
      const len = buffered[offset]
      if (buffered.length < 7 + len) return
      host = buffered.subarray(offset + 1, offset + 1 + len).toString()
      offset += 1 + len
    } else if (atyp === 4) {
      if (buffered.length < 22) return
      const address = buffered.subarray(offset, offset + 16)
      host = address.equals(Buffer.from("00000000000000000000000000000001", "hex")) ? "127.0.0.1" : address.toString("hex").match(/.{1,4}/g).join(":")
      offset += 16
    } else {
      socket.destroy()
      return
    }
    const port = buffered.readUInt16BE(offset)
    const rest = buffered.subarray(offset + 2)
    socket.removeListener("data", onData)
    const upstream = net.connect(port, host, () => {
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
      if (rest.length > 0) upstream.write(rest)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on("error", () => socket.destroy())
  }
}))

await Promise.all([
  new Promise((r) => h1.listen(H1_PORT, HOST, r)),
  new Promise((r) => h2c.listen(H2C_PORT, HOST, r)),
  new Promise((r) => httpProxy.listen(HTTP_PROXY_PORT, HOST, r)),
  new Promise((r) => socks.listen(SOCKS_PORT, HOST, r)),
  new Promise((r) => rawH1.listen(RAW_H1_PORT, HOST, r)),
  new Promise((r) => httpsOrigin.listen(HTTPS_PORT, HOST, r)),
  new Promise((r) => httpsProxy.listen(HTTPS_PROXY_PORT, HOST, r)),
])

console.log(JSON.stringify({ ready: true, pid: process.pid, ports: { H1_PORT, H2C_PORT, HTTP_PROXY_PORT, SOCKS_PORT, RAW_H1_PORT, HTTPS_PORT, HTTPS_PROXY_PORT } }))

async function shutdown() {
  for (const socket of sockets) socket.destroy()
  await Promise.allSettled([h1, h2c, httpProxy, socks, rawH1, httpsOrigin, httpsProxy].map((server) => new Promise((r) => server.close(r))))
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

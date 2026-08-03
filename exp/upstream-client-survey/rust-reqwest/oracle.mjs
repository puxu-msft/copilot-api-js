import http2 from "node:http2"

const port = Number(process.env.PORT ?? 19471)
const holdMs = Number(process.env.HOLD_MS ?? 550)
const pings = []
const server = http2.createServer()
server.on("session", (session) => {
  session.on("ping", (payload) => pings.push({ at: Date.now(), payload: payload.toString("hex") }))
})
server.on("stream", (stream, headers) => {
  if (headers[":path"] === "/events") {
    stream.respond({ ":status": 200, "content-type": "text/plain" }, { waitForTrailers: true })
    stream.write("prefix-")
    setTimeout(() => {
      stream.on("wantTrailers", () => stream.sendTrailers({ "x-oracle-trailer": "present" }))
      stream.end("suffix")
    }, holdMs)
    return
  }
  if (headers[":path"] === "/stats") {
    stream.respond({ ":status": 200, "content-type": "application/json" })
    stream.end(JSON.stringify({ pingCount: pings.length, pings }))
    return
  }
  stream.respond({ ":status": 404 })
  stream.end()
})
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port, pid: process.pid })))

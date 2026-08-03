import https from "node:https"
import fs from "node:fs"

const port = Number(process.env.PORT ?? 19473)
const certDir = "/home/xp/src/copilot-api-js/exp/curl-transport-exe"
let nextSocketId = 1
const socketIds = new WeakMap()
const server = https.createServer({ key: fs.readFileSync(`${certDir}/test-key.pem`), cert: fs.readFileSync(`${certDir}/test-cert.pem`) }, (req, res) => {
  let socketId = socketIds.get(req.socket)
  if (!socketId) {
    socketId = nextSocketId++
    socketIds.set(req.socket, socketId)
  }
  res.writeHead(200, { "x-socket-id": String(socketId), "content-type": "text/plain" })
  res.write("prefix-")
  setTimeout(() => res.end("suffix"), 120)
})
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port, pid: process.pid })))

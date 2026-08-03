import http from "node:http"

const port = Number(process.env.PORT ?? 19472)
let nextSocketId = 1
const socketIds = new WeakMap()
const server = http.createServer((req, res) => {
  let socketId = socketIds.get(req.socket)
  if (!socketId) {
    socketId = nextSocketId++
    socketIds.set(req.socket, socketId)
  }
  const common = { "x-socket-id": String(socketId) }
  if (req.url === "/echo") {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      res.writeHead(200, { ...common, "content-type": "application/json" })
      res.write(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }).slice(0, 10))
      setTimeout(() => res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }).slice(10)), 60)
    })
    return
  }
  if (req.url === "/chunked") {
    res.writeHead(200, { ...common, "content-type": "text/plain", trailer: "x-oracle-trailer" })
    res.write("prefix-")
    setTimeout(() => {
      res.addTrailers({ "x-oracle-trailer": "present" })
      res.end("suffix")
    }, 120)
    return
  }
  if (req.url === "/short") {
    res.writeHead(200, { ...common, "content-length": "20", "content-type": "text/plain" })
    res.write("short")
    setTimeout(() => req.socket.destroy(), 30)
    return
  }
  if (req.url === "/headers") {
    res.writeHead(200, { ...common, "content-type": "application/json" })
    res.end(JSON.stringify(req.rawHeaders))
    return
  }
  if (req.url === "/hold") {
    res.writeHead(200, { ...common, "content-type": "text/plain" })
    res.write("prefix")
    setTimeout(() => res.end("suffix"), 2000)
    return
  }
  res.writeHead(404, common)
  res.end("not found")
})
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port, pid: process.pid })))

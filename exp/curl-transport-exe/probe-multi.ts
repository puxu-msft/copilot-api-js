import net from "node:net"

const host = "127.0.0.1"
const port = 19085
let connections = 0
const requests = []
const server = net.createServer((socket) => {
  const connectionId = ++connections
  let buffer = Buffer.alloc(0)
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const marker = buffer.indexOf("\r\n\r\n")
      if (marker < 0) break
      const request = buffer.subarray(0, marker + 4).toString("latin1")
      buffer = buffer.subarray(marker + 4)
      const requestLine = request.split("\r\n", 1)[0]
      requests.push({ connectionId, requestLine, at: performance.now() })
      const body = `OK-${requests.length}`
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`)
    }
  })
})
await new Promise<void>((resolve) => server.listen(port, host, resolve))

const sequential = Bun.spawn({
  cmd: ["curl", "-q", "-sS", `http://${host}:${port}/one`, "--next", "-sS", `http://${host}:${port}/two`, "--next", "-sS", `http://${host}:${port}/three`],
  stdio: ["ignore", "pipe", "pipe"],
})
const seqOut = await new Response(sequential.stdout).text()
const seqErr = await new Response(sequential.stderr).text()
const seqExit = await sequential.exited
const seqSnapshot = { connections, requests: [...requests] }

connections = 0
requests.length = 0
const parallel = Bun.spawn({
  cmd: ["curl", "-q", "-sS", "--parallel", `http://${host}:${port}/p1`, `http://${host}:${port}/p2`, `http://${host}:${port}/p3`],
  stdio: ["ignore", "pipe", "pipe"],
})
const parOut = await new Response(parallel.stdout).text()
const parErr = await new Response(parallel.stderr).text()
const parExit = await parallel.exited
const parSnapshot = { connections, requests: [...requests] }
await new Promise<void>((resolve) => server.close(() => resolve()))
console.log(JSON.stringify({ sequential: { exit: seqExit, stdout: seqOut, stderr: seqErr, ...seqSnapshot }, parallel: { exit: parExit, stdout: parOut, stderr: parErr, ...parSnapshot } }))

import http from "node:http"

const port = 19086
let requests = 0
const server = http.createServer((_req, res) => {
  requests++
  res.end("CONFIG-OK")
})
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
const proc = Bun.spawn({ cmd: ["curl", "-q", "-sS", "-K", "-"], stdio: ["pipe", "pipe", "pipe"] })
proc.stdin.write(`url = "http://127.0.0.1:${port}/first"\n`)
await proc.stdin.flush()
await Bun.sleep(300)
const beforeEof = { requests, exited: proc.exitCode !== null }
proc.stdin.end()
const stdout = await new Response(proc.stdout).text()
const stderr = await new Response(proc.stderr).text()
const exit = await proc.exited
await new Promise<void>((resolve) => server.close(() => resolve()))
console.log(JSON.stringify({ beforeEof, afterEof: { requests, exit, stdout, stderr } }))

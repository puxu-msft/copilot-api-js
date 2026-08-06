import http from "node:http"

const base = new URL(process.argv[2])
if (!base) throw new Error("usage: probe-node-http.mjs <base-url>")
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

function request(path, { abortAfterMs, method = "GET", body } = {}) {
  return new Promise((resolve) => {
    const started = performance.now()
    const arrivals = []
    const controller = new AbortController()
    if (abortAfterMs) setTimeout(() => controller.abort(new Error("probe abort")), abortAfterMs)
    const req = http.request({ hostname: base.hostname, port: base.port, path, method, agent, signal: controller.signal, headers: { "x-explicit": "yes" } }, (res) => {
      let text = ""
      res.on("data", (chunk) => {
        text += chunk
        arrivals.push({ atMs: +(performance.now() - started).toFixed(1), text: chunk.toString() })
      })
      res.on("aborted", () => resolve({ error: "response aborted", text, arrivals, socketId: res.headers["x-socket-id"] }))
      res.on("error", (error) => resolve({ error: `${error.name}: ${error.message}`, text, arrivals, socketId: res.headers["x-socket-id"] }))
      res.on("end", () => resolve({ status: res.statusCode, text, arrivals, trailers: res.trailers, socketId: res.headers["x-socket-id"] }))
    })
    req.on("error", (error) => resolve({ error: `${error.name}: ${error.message}` }))
    req.end(body)
  })
}

const chunked = await request("/chunked")
const post = await request("/echo", { method: "POST", body: "request-body" })
const short = await request("/short")
const first = await request("/headers")
const second = await request("/headers")
const aborted = await request("/hold", { abortAfterMs: 80 })
agent.destroy()
console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`, chunked, post, short, first, second, aborted }))

import https from "node:https"

const port = Number(process.argv[2] ?? 19473)
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false })

function request() {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const arrivals = []
    const req = https.request({ hostname: "127.0.0.1", port, path: "/", agent, rejectUnauthorized: false }, (res) => {
      let text = ""
      res.on("data", (chunk) => {
        text += chunk
        arrivals.push({ atMs: +(performance.now() - started).toFixed(1), text: chunk.toString() })
      })
      res.on("end", () => resolve({ status: res.statusCode, text, arrivals, socketId: res.headers["x-socket-id"] }))
      res.on("error", reject)
    })
    req.on("error", reject)
    req.end()
  })
}

try {
  const first = await request()
  const second = await request()
  console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`, first, second }))
} finally {
  agent.destroy()
}

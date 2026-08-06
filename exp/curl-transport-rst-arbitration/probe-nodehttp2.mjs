// Leg C: is the length-less RST genuinely undetectable, or is that a curl choice?
// Runs the same oracle endpoints through node:http2 under BOTH runtimes. If Node
// surfaces an error where curl reports success, "truncation is undetectable" is
// false — it is a curl reporting decision, and the capability exists elsewhere.
import * as http2 from "node:http2"

const port = process.argv[2]
const paths = ["/ok-nolen", "/rst-len", "/rst-nolen", "/rst-sse"]
const runtime = typeof globalThis.Bun === "undefined" ? "node" : "bun"

for (const p of paths) {
  const session = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false })
  session.on("error", () => {})
  const events = []
  const body = []
  await new Promise((resolve) => {
    const req = session.request({ ":path": p })
    req.on("response", () => events.push("response"))
    req.on("data", (c) => body.push(c.toString()))
    req.on("error", (e) => {
      events.push(`error:${e.code}`)
      resolve()
    })
    req.on("end", () => events.push("end"))
    req.on("close", () => {
      events.push(`close:rst=${req.rstCode}`)
      resolve()
    })
    setTimeout(resolve, 3000)
  })
  session.close()
  const detected = events.some((e) => e.startsWith("error:")) || !events.includes("end")
  console.log(JSON.stringify({ leg: `node-http2-${runtime}`, path: p, events, detectedTruncation: detected, body: body.join("") }))
}

import http2 from "node:http2"

import { PORTS } from "./lib"

const cases = ["ok", "rst", "destroy"]
for (const path of cases) {
  const session = http2.connect(`http://127.0.0.1:${PORTS.h2c}`)
  const req = session.request({ ":path": `/${path}` })
  const events = []
  let body = ""
  for (const event of ["response", "data", "end", "error", "close"] as const) {
    req.on(event, (...args) => {
      if (event === "data") body += Buffer.from(args[0] as Uint8Array).toString()
      events.push({ event, rstCode: req.rstCode, arg: event === "error" ? String(args[0]) : event === "data" ? Buffer.from(args[0] as Uint8Array).toString() : undefined })
    })
  }
  req.end()
  await new Promise<void>((resolve) => req.once("close", resolve))
  console.log(JSON.stringify({ path, body, events }))
  session.destroy()
}

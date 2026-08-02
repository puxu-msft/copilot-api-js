import http2 from "node:http2"

const session = http2.connect("http://127.0.0.1:19081")
await new Promise((resolve, reject) => {
  session.once("connect", resolve)
  session.once("error", reject)
})
await new Promise((resolve, reject) => session.ping((err, duration, payload) => err ? reject(err) : resolve({ duration, payload })))
const req = session.request({ ":path": "/ok" })
req.resume()
req.end()
await new Promise((resolve, reject) => {
  req.once("end", resolve)
  req.once("error", reject)
})
session.close()
console.log(JSON.stringify({ sent: true }))

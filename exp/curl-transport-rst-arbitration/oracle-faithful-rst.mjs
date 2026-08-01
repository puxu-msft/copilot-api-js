import * as fs from "node:fs"; import * as http2 from "node:http2"; import * as path from "node:path"
const certDir = "/home/xp/src/copilot-api-js/exp/curl-transport-libcurl"
const server = http2.createSecureServer({ key: fs.readFileSync(path.join(certDir,"test-key.pem")), cert: fs.readFileSync(path.join(certDir,"test-cert.pem")) })
server.on("session", s => s.on("error", ()=>{}))
server.on("stream", (stream, h) => {
  stream.on("error", ()=>{})
  const p = String(h[":path"])
  stream.respond({ ":status": 200, "content-type": "text/event-stream" })
  stream.write("event: message_start\ndata: {}\n\n")
  // Variant A: close() one tick later, after the DATA frame has certainly flushed.
  if (p === "/a") setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 50)
  // Variant B: destroy the stream with an error instead of close().
  if (p === "/b") setTimeout(() => stream.destroy(new Error("boom")), 50)
  // Variant C: reach under Node and emit the RST_STREAM frame via the session's
  // internal rstStream, which is what close() is supposed to call.
  if (p === "/c") setTimeout(() => { try { stream.close(http2.constants.NGHTTP2_REFUSED_STREAM) } catch {} }, 50)
})
server.listen(0,"127.0.0.1",()=>process.stdout.write(JSON.stringify({port:server.address().port})+"\n"))

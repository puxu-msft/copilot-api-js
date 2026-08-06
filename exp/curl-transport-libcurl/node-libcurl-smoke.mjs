#!/usr/bin/env node
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const packageRoot = process.env.NODE_LIBCURL_ROOT ?? "/tmp/copilot-libcurl-node-poc/node_modules/node-libcurl"
const { Curl } = require(`${packageRoot}/dist/index.js`)
const url = process.env.SMOKE_URL ?? "https://example.com/"
const curl = new Curl()
const chunks = []
const callbackTimes = []
const started = performance.now()
curl.setOpt(Curl.option.URL, url)
curl.on("data", (chunk) => {
  chunks.push(Buffer.from(chunk))
  callbackTimes.push(+(performance.now() - started).toFixed(1))
  return chunk.length
})
curl.on("end", (statusCode) => {
  console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`, libcurl: Curl.getVersion(), statusCode, bytes: Buffer.concat(chunks).length, callbackTimes, elapsedMs: +(performance.now() - started).toFixed(1), httpVersion: curl.getInfo("HTTP_VERSION") }))
  curl.close()
})
curl.on("error", (error, code) => {
  console.error(JSON.stringify({ code, error: error.message }))
  curl.close()
  process.exitCode = 1
})
curl.perform()

#!/usr/bin/env node
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const packageRoot = process.env.NODE_LIBCURL_ROOT ?? "/tmp/copilot-libcurl-node-poc/node_modules/node-libcurl"
const { Curl } = require(`${packageRoot}/dist/index.js`)
const origin = process.env.H2_ORIGIN ?? "https://127.0.0.1:18443"

const curl = new Curl()
const started = performance.now()
const chunks = []
const chunkTimes = []
let upkeepCalls = 0
let upkeepErrors = 0
curl.setOpt(Curl.option.URL, `${origin}/hold-long`)
curl.setOpt(Curl.option.HTTP_VERSION, 4)
curl.setOpt(Curl.option.SSL_VERIFYPEER, false)
curl.setOpt(Curl.option.SSL_VERIFYHOST, false)
curl.setOpt(Curl.option.UPKEEP_INTERVAL_MS, 100)
curl.setOpt(Curl.option.TCP_KEEPALIVE, true)
curl.setOpt(Curl.option.TCP_KEEPIDLE, 2)
curl.setOpt(Curl.option.TCP_KEEPINTVL, 2)
curl.on("data", (chunk) => {
  chunks.push(Buffer.from(chunk))
  chunkTimes.push(+(performance.now() - started).toFixed(1))
  return chunk.length
})
const upkeepTimer = setInterval(() => {
  upkeepCalls += 1
  if (curl.handle.upkeep() !== 0) upkeepErrors += 1
}, 120)
curl.on("end", (statusCode) => {
  clearInterval(upkeepTimer)
  console.log(JSON.stringify({ probe: "node-libcurl-active-upkeep", runtime: process.version, libcurl: Curl.getVersion(), statusCode, elapsedMs: +(performance.now() - started).toFixed(1), bytes: Buffer.concat(chunks).length, chunkTimes, upkeepCalls, upkeepErrors, httpVersion: curl.getInfo("HTTP_VERSION") }))
  curl.close()
})
curl.on("error", (error, code) => {
  clearInterval(upkeepTimer)
  console.error(JSON.stringify({ probe: "node-libcurl-active-upkeep", code, error: error.message, upkeepCalls, upkeepErrors }))
  curl.close()
  process.exitCode = 1
})
curl.perform()

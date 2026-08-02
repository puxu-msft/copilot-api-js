#!/usr/bin/env bun
import { Libcurl, resultForJson } from "./ffi-libcurl"

const h2 = process.env.H2_ORIGIN ?? "https://127.0.0.1:18443"
const h1 = process.env.H1_ORIGIN ?? "https://127.0.0.1:18444"
const curl = new Libcurl()
console.log(JSON.stringify({ probe: "environment", bun: Bun.version, libcurl: curl.version, libraryPath: curl.libraryPath }))

function run(name: string, url: string, extra = {}) {
  const result = curl.perform({ url, insecure: true, ...extra })
  console.log(JSON.stringify({ probe: name, ...resultForJson(result) }))
  return result
}

run("h2-stream-trailers", `${h2}/stream-trailers`)
run("h2-rst", `${h2}/rst`)
run("h2-destroy", `${h2}/destroy`)
run("h1-chunk-drop", `${h1}/chunk-drop`, { http2: false })
run("h1-length-drop", `${h1}/length-drop`, { http2: false })

const easy = curl.createEasy()
const first = run("reuse-first", `${h2}/reuse-1`, { easy })
const second = run("reuse-second", `${h2}/reuse-2`, { easy })
console.log(
  JSON.stringify({
    probe: "reuse-comparison",
    sameConnId: first.connId === second.connId,
    firstConnId: first.connId.toString(),
    secondConnId: second.connId.toString(),
    firstNumConnects: first.numConnects,
    secondNumConnects: second.numConnects,
    firstTtfbMs: first.timings.startTransferMs,
    secondTtfbMs: second.timings.startTransferMs,
    firstTlsMs: first.timings.appConnectMs,
    secondTlsMs: second.timings.appConnectMs,
  }),
)
curl.cleanupEasy(easy)

run("abort-write-callback", `${h2}/hold`, { abortAfterFirstBodyChunk: true })
run("abort-progress-callback", `${h2}/hold`, { abortAfterMs: 180 })

let ticks = 0
let maxGapMs = 0
let previous = performance.now()
const timer = setInterval(() => {
  const now = performance.now()
  maxGapMs = Math.max(maxGapMs, now - previous)
  previous = now
  ticks += 1
}, 10)
const blockingStarted = performance.now()
run("blocking-easy", `${h2}/hold`)
const blockingWallMs = performance.now() - blockingStarted
await new Promise((resolve) => setTimeout(resolve, 40))
clearInterval(timer)
console.log(JSON.stringify({ probe: "blocking-metronome", wallMs: +blockingWallMs.toFixed(1), ticksDuringAnd40msAfter: ticks, maxGapMs: +maxGapMs.toFixed(1) }))

curl.close()

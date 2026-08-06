#!/usr/bin/env bun
import { JSCallback, dlopen, read, toArrayBuffer } from "bun:ffi"

const LIB = process.env.LIBCURL_PATH ?? "/lib/x86_64-linux-gnu/libcurl.so.4"
const h2 = process.env.H2_ORIGIN ?? "https://127.0.0.1:18443"
const mode = process.argv[2] ?? "all"
const CURLMSG_DONE = 1
const OPT = { URL: 10002, WRITEFUNCTION: 20011, HEADERFUNCTION: 20079, HTTP_VERSION: 84, SSL_VERIFYPEER: 64, SSL_VERIFYHOST: 81, TCP_KEEPALIVE: 213, TCP_KEEPIDLE: 214, TCP_KEEPINTVL: 215, UPKEEP_INTERVAL_MS: 281 }
const INFO = { ACTIVESOCKET: 0x500000 + 44 }

const base = dlopen(LIB, {
  curl_global_init: { args: ["i64"], returns: "i32" }, curl_global_cleanup: { returns: "void" },
  curl_easy_init: { returns: "ptr" }, curl_easy_cleanup: { args: ["ptr"], returns: "void" }, curl_easy_upkeep: { args: ["ptr"], returns: "i32" },
  curl_easy_strerror: { args: ["i32"], returns: "cstring" }, curl_version: { returns: "cstring" },
  curl_multi_init: { returns: "ptr" }, curl_multi_cleanup: { args: ["ptr"], returns: "i32" },
  curl_multi_add_handle: { args: ["ptr", "ptr"], returns: "i32" }, curl_multi_remove_handle: { args: ["ptr", "ptr"], returns: "i32" },
  curl_multi_perform: { args: ["ptr", "ptr"], returns: "i32" }, curl_multi_info_read: { args: ["ptr", "ptr"], returns: "ptr" },
})
const setPtr = dlopen(LIB, { curl_easy_setopt: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
const setLong = dlopen(LIB, { curl_easy_setopt: { args: ["ptr", "i32", "i64"], returns: "i32" } })
const setCallback = dlopen(LIB, { curl_easy_setopt: { args: ["ptr", "i32", "function"], returns: "i32" } })
const getSocket = dlopen(LIB, { curl_easy_getinfo: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
base.symbols.curl_global_init(3n)

function z(value: string): Uint8Array { return new TextEncoder().encode(`${value}\0`) }
function curlError(code: number): string { return String(base.symbols.curl_easy_strerror(code)) }

interface MultiOptions { url: string; abortAfterMs?: number; upkeepEveryMs?: number; tcpKeepalive?: boolean }
async function performMulti(options: MultiOptions) {
  const easy = base.symbols.curl_easy_init()
  const multi = base.symbols.curl_multi_init()
  if (!easy || !multi) throw new Error("curl handle allocation failed")
  const url = z(options.url)
  const started = performance.now()
  const chunks: Array<{ atMs: number; text: string }> = []
  const headers: Array<{ atMs: number; line: string }> = []
  const write = new JSCallback((p: number, size: bigint, count: bigint) => {
    const n = Number(size * count)
    const bytes = new Uint8Array(toArrayBuffer(p as never, 0, n)).slice()
    chunks.push({ atMs: +(performance.now() - started).toFixed(1), text: new TextDecoder().decode(bytes) })
    return BigInt(n)
  }, { args: ["ptr", "u64", "u64", "ptr"], returns: "u64" })
  const header = new JSCallback((p: number, size: bigint, count: bigint) => {
    const n = Number(size * count)
    const bytes = new Uint8Array(toArrayBuffer(p as never, 0, n)).slice()
    headers.push({ atMs: +(performance.now() - started).toFixed(1), line: new TextDecoder().decode(bytes).replace(/\r?\n$/, "") })
    return BigInt(n)
  }, { args: ["ptr", "u64", "u64", "ptr"], returns: "u64" })
  const check = (code: number, name: string) => { if (code !== 0) throw new Error(`${name} failed: ${code}`) }
  check(setPtr.symbols.curl_easy_setopt(easy, OPT.URL, url), "URL")
  check(setCallback.symbols.curl_easy_setopt(easy, OPT.WRITEFUNCTION, write), "WRITEFUNCTION")
  check(setCallback.symbols.curl_easy_setopt(easy, OPT.HEADERFUNCTION, header), "HEADERFUNCTION")
  check(setLong.symbols.curl_easy_setopt(easy, OPT.HTTP_VERSION, 4n), "HTTP_VERSION")
  check(setLong.symbols.curl_easy_setopt(easy, OPT.SSL_VERIFYPEER, 0n), "SSL_VERIFYPEER")
  check(setLong.symbols.curl_easy_setopt(easy, OPT.SSL_VERIFYHOST, 0n), "SSL_VERIFYHOST")
  if (options.tcpKeepalive) {
    check(setLong.symbols.curl_easy_setopt(easy, OPT.TCP_KEEPALIVE, 1n), "TCP_KEEPALIVE")
    check(setLong.symbols.curl_easy_setopt(easy, OPT.TCP_KEEPIDLE, 2n), "TCP_KEEPIDLE")
    check(setLong.symbols.curl_easy_setopt(easy, OPT.TCP_KEEPINTVL, 2n), "TCP_KEEPINTVL")
  }
  if (options.upkeepEveryMs) check(setLong.symbols.curl_easy_setopt(easy, OPT.UPKEEP_INTERVAL_MS, BigInt(options.upkeepEveryMs)), "UPKEEP_INTERVAL_MS")
  check(base.symbols.curl_multi_add_handle(multi, easy), "multi_add")

  let ticks = 0
  let maxGapMs = 0
  let previous = performance.now()
  const metronome = setInterval(() => {
    const now = performance.now()
    maxGapMs = Math.max(maxGapMs, now - previous)
    previous = now
    ticks += 1
  }, 10)
  let upkeepCalls = 0
  let upkeepErrors = 0
  const upkeep = options.upkeepEveryMs ? setInterval(() => {
    upkeepCalls += 1
    if (base.symbols.curl_easy_upkeep(easy) !== 0) upkeepErrors += 1
  }, options.upkeepEveryMs + 20) : undefined

  const running = new Int32Array(1)
  const queued = new Int32Array(1)
  let resultCode = -999
  let removed = false
  let removeLatencyMs: number | undefined
  let activeSocket = -1n
  let multiIterations = 0
  while (true) {
    multiIterations += 1
    const multiCode = base.symbols.curl_multi_perform(multi, running)
    if (multiCode !== 0) throw new Error(`multi_perform failed: ${multiCode} at iteration ${multiIterations}, running=${running[0]}`)
    const socketView = new BigInt64Array(1)
    if (getSocket.symbols.curl_easy_getinfo(easy, INFO.ACTIVESOCKET, socketView) === 0) activeSocket = socketView[0]
    if (options.abortAfterMs !== undefined && performance.now() - started >= options.abortAfterMs) {
      const removeStarted = performance.now()
      check(base.symbols.curl_multi_remove_handle(multi, easy), "multi_remove")
      removeLatencyMs = performance.now() - removeStarted
      removed = true
      break
    }
    if (running[0] === 0) {
      const message = base.symbols.curl_multi_info_read(multi, queued)
      if (message && read.i32(message as never, 0) === CURLMSG_DONE) resultCode = read.i32(message as never, 16)
      break
    }
    await Bun.sleep(5)
  }
  clearInterval(metronome)
  if (upkeep) clearInterval(upkeep)
  if (!removed) check(base.symbols.curl_multi_remove_handle(multi, easy), "multi_remove completed")
  const elapsedMs = performance.now() - started
  base.symbols.curl_multi_cleanup(multi)
  base.symbols.curl_easy_cleanup(easy)
  write.close(); header.close()
  return {
    code: removed ? "removed" : resultCode,
    error: removed ? "removed from multi" : curlError(resultCode),
    elapsedMs: +elapsedMs.toFixed(1), chunks, headers,
    metronomeTicks: ticks, maxMetronomeGapMs: +maxGapMs.toFixed(1),
    upkeepCalls, upkeepErrors, activeSocket: activeSocket.toString(),
    ...(removeLatencyMs === undefined ? {} : { removeLatencyMs: +removeLatencyMs.toFixed(3) }),
  }
}

console.log(JSON.stringify({ probe: "multi-environment", bun: Bun.version, libcurl: String(base.symbols.curl_version()) }))
if (mode === "all") {
  console.log(JSON.stringify({ probe: "multi-streaming-metronome", ...(await performMulti({ url: `${h2}/stream-trailers` })) }))
  console.log(JSON.stringify({ probe: "multi-remove-abort", ...(await performMulti({ url: `${h2}/hold`, abortAfterMs: 180 })) }))
} else if (mode === "keepalive") {
  console.log(JSON.stringify({ probe: "multi-upkeep-keepalive", pid: process.pid, ...(await performMulti({ url: `${h2}/hold-long`, upkeepEveryMs: 100, tcpKeepalive: true })) }))
}
base.symbols.curl_global_cleanup()
getSocket.close(); setCallback.close(); setLong.close(); setPtr.close(); base.close()

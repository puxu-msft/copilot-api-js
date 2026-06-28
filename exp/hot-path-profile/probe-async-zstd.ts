/**
 * Probe①: does node:zlib's ASYNC zstdCompress offload to the libuv threadpool
 * under Bun — i.e. does the event loop stay responsive during a 6MB compress?
 *
 * Method: run a setInterval(1ms) "metronome" and measure its tick jitter while
 * compressing the real 6MB request_group payload (a) synchronously vs (b) async.
 * If async truly offloads, metronome jitter during async ≈ idle; sync freezes it.
 */
import { readFileSync } from "node:fs"
import { promisify } from "node:util"
import zlib from "node:zlib"

const DIR = import.meta.dirname
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
// Reconstruct the combined ~6MB request_group payload (inbound+effective+outbound)
const combined = JSON.stringify([entry.inboundRequest, entry.effectiveRequest, entry.outboundRequest])
const buf = Buffer.from(combined)
console.log(`payload: ${(buf.length / 1024 / 1024).toFixed(2)} MB`)

const hasAsync = typeof (zlib as Record<string, unknown>).zstdCompress === "function"
console.log(`node:zlib.zstdCompress (async) present under Bun: ${hasAsync}`)
if (!hasAsync) { console.log("→ async zstd NOT available; Stage 1 needs a worker"); process.exit(0) }

const zstdAsync = promisify(zlib.zstdCompress) as (b: Buffer) => Promise<Buffer>
const zstdSync = zlib.zstdCompressSync as (b: Buffer) => Buffer

// metronome: record gaps beyond the 1ms target — large gaps = event-loop frozen
function startMetronome() {
  let last = Bun.nanoseconds()
  let maxGapMs = 0
  const gaps: number[] = []
  const id = setInterval(() => {
    const now = Bun.nanoseconds()
    const gap = (now - last) / 1e6
    last = now
    gaps.push(gap)
    if (gap > maxGapMs) maxGapMs = gap
  }, 1)
  ;(id as unknown as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(id), get maxGapMs() { return maxGapMs }, get p99() { return gaps.sort((a,b)=>a-b)[Math.floor(gaps.length*0.99)] ?? 0 } }
}

async function measure(label: string, run: () => void | Promise<void>) {
  const m = startMetronome()
  await new Promise((r) => setTimeout(r, 50)) // baseline settle
  const t = Bun.nanoseconds()
  await run()
  const wallMs = (Bun.nanoseconds() - t) / 1e6
  await new Promise((r) => setTimeout(r, 50))
  m.stop()
  console.log(`[${label}] wall=${wallMs.toFixed(1)}ms  metronome max-gap=${m.maxGapMs.toFixed(1)}ms  p99=${m.p99.toFixed(2)}ms`)
}

// 8 concurrent 6MB compresses — simulates 8 concurrent request finalizes
await measure("SYNC  x8 sequential", () => { for (let i=0;i<8;i++) zstdSync(buf) })
await measure("ASYNC x8 concurrent", async () => { await Promise.all(Array.from({length:8},()=>zstdAsync(buf))) })

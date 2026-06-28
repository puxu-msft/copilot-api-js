/** Probe②b: does cooperative-yield (await sleep(0) every K messages) keep the
 * event loop responsive while building the per-message index? + combined
 * Stage1(async zstd)+Stage2(yield build) under 8 concurrent finalizes. */
import { readFileSync } from "node:fs"
import { promisify } from "node:util"
import zlib from "node:zlib"
import { hashMessage, normalizeMessageForIndex } from "~/lib/history/normalize-message"

const DIR = import.meta.dirname
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
const fmt = "anthropic" as never
const msgs = entry.inboundRequest?.messages ?? []
const combined = Buffer.from(JSON.stringify([entry.inboundRequest, entry.effectiveRequest, entry.outboundRequest]))
const zstdAsync = promisify(zlib.zstdCompress) as (b: Buffer) => Promise<Buffer>
const zstdSync = zlib.zstdCompressSync as (b: Buffer) => Buffer
const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0))

function metronome() {
  let last = Bun.nanoseconds(); let maxGap = 0; const g:number[]=[]
  const id = setInterval(() => { const n=Bun.nanoseconds(); const d=(n-last)/1e6; last=n; g.push(d); if(d>maxGap)maxGap=d }, 1)
  ;(id as unknown as {unref?:()=>void}).unref?.()
  return { stop:()=>clearInterval(id), get max(){return maxGap}, get p99(){return g.sort((a,b)=>a-b)[Math.floor(g.length*0.99)]??0} }
}
// chunked per-message build, yielding every K messages
async function buildChunked(K: number) {
  const out:Array<{hash:string}> = []
  for (let p=0;p<msgs.length;p++){ out.push({ hash: hashMessage(msgs[p],fmt) }); void normalizeMessageForIndex(msgs[p],fmt); if (p%K===K-1) await sleep0() }
  return out
}
async function measure(label:string, run:()=>Promise<void>|void){
  const m=metronome(); await sleep0()
  const t=Bun.nanoseconds(); await run(); const wall=(Bun.nanoseconds()-t)/1e6
  await new Promise(r=>setTimeout(r,30)); m.stop()
  console.log(`[${label}] wall=${wall.toFixed(1)}ms  max-gap=${m.max.toFixed(1)}ms  p99=${m.p99.toFixed(2)}ms`)
}

console.log(`${msgs.length} messages`)
// current sync finalize ≈ sync build + sync compress
await measure("CURRENT: sync build + sync compress (x8)", () => { for(let i=0;i<8;i++){ for(let p=0;p<msgs.length;p++){hashMessage(msgs[p],fmt);normalizeMessageForIndex(msgs[p],fmt)} zstdSync(combined) } })
// proposed: chunked build + async compress, 8 concurrent
await measure("PROPOSED: yield-build + async-compress (x8)", async () => { await Promise.all(Array.from({length:8},async()=>{ await buildChunked(50); await zstdAsync(combined) })) })

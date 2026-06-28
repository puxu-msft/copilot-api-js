/** Probe: split buildSearchIndex into buildInboundMsgs vs buildAux(rewritesReq align /
 * rewritesResp / headers) to size P3's chunking scope. */
import { readFileSync } from "node:fs"
import { alignWithModified } from "~/lib/diff/block-align"
import { hashMessage, normalizeMessageForIndex } from "~/lib/history/normalize-message"

const DIR = import.meta.dirname
const e = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
const fmt = "anthropic" as never
const inMsgs = e.inboundRequest?.messages ?? []
const effMsgs = e.effectiveRequest?.payload?.messages ?? e.effectiveRequest?.messages ?? []
const time = (l: string, fn: () => void, reps = 20) => { for (let i=0;i<3;i++) fn(); const t=Bun.nanoseconds(); for (let i=0;i<reps;i++) fn(); console.log(`  ${l.padEnd(46)} ${((Bun.nanoseconds()-t)/1e6/reps).toFixed(2)} ms`) }
console.log(`inbound msgs=${inMsgs.length}  effective msgs=${effMsgs.length}`)
time("buildInboundMsgs (.map hash+normalize — CHUNKABLE)", () => inMsgs.map((m:never,p:number)=>({pos:p,hash:hashMessage(m,fmt),text:normalizeMessageForIndex(m,fmt)})))
time("rewritesReq align eff-vs-in (jsdiff over msgs — MONOLITHIC)", () => alignWithModified(inMsgs, effMsgs, (m:never)=>normalizeMessageForIndex(m,fmt), (m:never)=>(m as {role?:string}).role??""))

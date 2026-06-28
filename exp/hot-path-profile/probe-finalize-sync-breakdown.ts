/** Attribute the residual synchronous cost in ONE async insertCompletedEntry. */
import { readFileSync } from "node:fs"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"
import { extractHeadMetaPayload, extractStagePayloads, partitionStagesForWrite } from "~/lib/history/sqlite/serialize"
const DIR = import.meta.dirname
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
const time=(l:string,fn:()=>void,reps=20)=>{for(let i=0;i<3;i++)fn();const t=Bun.nanoseconds();for(let i=0;i<reps;i++)fn();console.log(`  ${l.padEnd(46)} ${((Bun.nanoseconds()-t)/1e6/reps).toFixed(2)} ms`)}
const stages = extractStagePayloads(entry)
const { groupRow, rest } = partitionStagesForWrite(stages)
const toCompress = groupRow ? [...rest, groupRow] : rest
console.log("per-finalize SYNCHRONOUS components (NOT offloaded by libuv):")
time("buildSearchIndexForEntry whole (sync, incl buildAux jsdiff)", () => buildSearchIndexForEntry(entry))
time("extractStagePayloads + partition", () => partitionStagesForWrite(extractStagePayloads(entry)))
time("JSON.stringify(headMeta)", () => JSON.stringify(extractHeadMetaPayload(entry)))
time("JSON.stringify(ALL blobs = what compressAsync does sync)", () => { JSON.stringify(extractHeadMetaPayload(entry)); for (const s of toCompress) JSON.stringify(s.payload) })
const gbytes = Buffer.byteLength(JSON.stringify(groupRow?.payload ?? {}))
console.log(`  (request_group payload = ${(gbytes/1024/1024).toFixed(1)}MB)`)

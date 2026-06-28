/** End-to-end proof: drive the REAL now-async insertCompletedEntry on the real
 * large entry (504KB→2MB inbound, 1977 frames) under 8 concurrent finalizes,
 * measuring event-loop metronome jitter. Pre-refactor this was a ~758ms freeze. */
import { readFileSync } from "node:fs"
import { openInMemoryDatabase, closeDatabase } from "~/lib/history/sqlite/connection"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

const DIR = import.meta.dirname
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
closeDatabase(); openInMemoryDatabase()

function metronome() {
  let last = Bun.nanoseconds(); let maxGap = 0; const g:number[]=[]
  const id = setInterval(() => { const n=Bun.nanoseconds(); const d=(n-last)/1e6; last=n; g.push(d); if(d>maxGap)maxGap=d }, 1)
  ;(id as unknown as {unref?:()=>void}).unref?.()
  return { stop:()=>clearInterval(id), get max(){return maxGap}, get p99(){return g.sort((a,b)=>a-b)[Math.floor(g.length*0.99)]??0} }
}
// 8 concurrent real finalizes (distinct ids)
const m = metronome()
await new Promise(r=>setTimeout(r,30))
const t = Bun.nanoseconds()
await Promise.all(Array.from({length:8}, (_,i) => insertCompletedEntry({ ...entry, id: `probe-${i}` })))
const wall = (Bun.nanoseconds()-t)/1e6
await new Promise(r=>setTimeout(r,30)); m.stop()
console.log(`REAL async insertCompletedEntry x8 concurrent: wall=${wall.toFixed(0)}ms  event-loop max-gap=${m.max.toFixed(1)}ms  p99=${m.p99.toFixed(2)}ms`)
console.log(`(pre-refactor baseline for the same work was a ~758ms event-loop FREEZE)`)
closeDatabase()

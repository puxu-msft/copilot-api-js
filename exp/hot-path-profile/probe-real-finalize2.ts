import { readFileSync } from "node:fs"
import { openInMemoryDatabase, closeDatabase } from "~/lib/history/sqlite/connection"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
const DIR = import.meta.dirname
const entry = JSON.parse(readFileSync(`${DIR}/entry-803.json`, "utf8"))
closeDatabase(); openInMemoryDatabase()
function metronome() { let last=Bun.nanoseconds(); let mx=0; const g:number[]=[]
  const id=setInterval(()=>{const n=Bun.nanoseconds();const d=(n-last)/1e6;last=n;g.push(d);if(d>mx)mx=d},1)
  ;(id as unknown as {unref?:()=>void}).unref?.(); return {stop:()=>clearInterval(id),get max(){return mx},get p99(){return g.sort((a,b)=>a-b)[Math.floor(g.length*0.99)]??0}} }
async function run(label:string, n:number){ const m=metronome(); await new Promise(r=>setTimeout(r,30))
  const t=Bun.nanoseconds(); await Promise.all(Array.from({length:n},(_,i)=>insertCompletedEntry({...entry,id:`${label}-${i}`})))
  const wall=(Bun.nanoseconds()-t)/1e6; await new Promise(r=>setTimeout(r,30)); m.stop()
  console.log(`${label.padEnd(22)} n=${n}  wall=${wall.toFixed(0)}ms  max-gap=${m.max.toFixed(1)}ms  p99=${m.p99.toFixed(2)}ms`) }
// warmup (JIT + GC) then measure
await run("warmup", 3)
await run("single finalize", 1)
await run("4 concurrent", 4)
await run("8 concurrent", 8)
closeDatabase()

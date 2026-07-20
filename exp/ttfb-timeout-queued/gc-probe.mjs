// H2: AbortSignal.any([AbortSignal.timeout(ms), other]) — does the inner timeout
// get GC'd (timer collected) when no strong ref is retained, so it never fires?
// Mirrors combineAbortSignals: the timeout signal is only an ARGUMENT; after the
// call only the `any` composite survives (holds sources weakly in buggy impls).
const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node"
const forceGc = () => { if (typeof globalThis.Bun !== "undefined") Bun.gc(true); else if (globalThis.gc) globalThis.gc() }

function combineLikeProd(...signals) {
  const valid = signals.filter((s) => s !== undefined)
  if (valid.length === 1) return valid[0]
  return AbortSignal.any(valid)   // exact prod line (stream.ts:116)
}

async function run(ms) {
  const never = new AbortController().signal
  // EXACTLY like send.ts: timeout signal created inline, passed as arg, not retained.
  const composite = combineLikeProd(AbortSignal.timeout(ms), never, new AbortController().signal)
  const t0 = Date.now()
  let fired = false
  composite.addEventListener("abort", () => { fired = true; console.log(`[${runtime}] FIRED after ${Date.now()-t0}ms`) })
  // Aggressive GC pressure over the whole window (busy server proxy).
  const iv = setInterval(() => { forceGc(); for (let i=0;i<5;i++){ const junk=new Array(50000).fill(i); void junk } }, 50)
  await new Promise((r) => setTimeout(r, ms + 800))
  clearInterval(iv)
  console.log(`[${runtime}] verdict: fired=${fired} aborted=${composite.aborted} (expected fired=true at ~${ms}ms)`) 
}
await run(1500)

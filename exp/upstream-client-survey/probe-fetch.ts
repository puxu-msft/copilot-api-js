const base = process.argv[2]
if (!base) throw new Error("usage: probe-fetch.ts <base-url>")

async function readIncrementally(url: string) {
  const started = performance.now()
  const response = await fetch(url, { headers: { "x-explicit": "yes" } })
  const reader = response.body!.getReader()
  const arrivals: Array<{ atMs: number; text: string }> = []
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = new TextDecoder().decode(value)
    text += chunk
    arrivals.push({ atMs: +(performance.now() - started).toFixed(1), text: chunk })
  }
  return { status: response.status, text, arrivals, socketId: response.headers.get("x-socket-id") }
}

const chunked = await readIncrementally(`${base}/chunked`)
let short: unknown
try {
  short = await readIncrementally(`${base}/short`)
} catch (error) {
  short = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
}
const first = await fetch(`${base}/headers`, { headers: { "x-explicit": "yes" } })
const firstHeaders = await first.json()
const second = await fetch(`${base}/headers`, { headers: { "x-explicit": "yes" } })
const secondHeaders = await second.json()
const abort = new AbortController()
setTimeout(() => abort.abort(new Error("probe abort")), 80)
let aborted: unknown
try {
  await (await fetch(`${base}/hold`, { signal: abort.signal })).text()
  aborted = { unexpected: "completed" }
} catch (error) {
  aborted = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
}
console.log(JSON.stringify({ runtime: `bun ${Bun.version}`, chunked, short, firstHeaders, secondHeaders, firstSocketId: first.headers.get("x-socket-id"), secondSocketId: second.headers.get("x-socket-id"), aborted }))

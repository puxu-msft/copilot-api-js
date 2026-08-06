// Cross the confounded variable: {curl exe, in-process libcurl via bun:ffi}
// x {content-length present, absent, absent+SSE, clean control}.
import { Libcurl } from "../curl-transport-libcurl/ffi-libcurl.ts"

const PATHS = ["/ok-nolen", "/rst-len", "/rst-nolen", "/rst-sse"]

const oracle = Bun.spawn(["node", new URL("./oracle.mjs", import.meta.url).pathname], { stdout: "pipe", stderr: "inherit" })
// Read only the ready line — the oracle keeps stdout open, so draining to EOF hangs.
const reader = oracle.stdout.getReader()
let buf = ""
while (!buf.includes("\n")) {
  const { done, value } = await reader.read()
  if (done) break
  buf += new TextDecoder().decode(value)
}
reader.releaseLock()
const port: number = JSON.parse(buf.split("\n")[0]).port
const base = `https://127.0.0.1:${port}`

const rows: Array<Record<string, unknown>> = []

// --- Leg A: curl executable -------------------------------------------------
for (const p of PATHS) {
  const proc = Bun.spawn(["curl", "-sS", "-N", "-k", "--http2", `${base}${p}`], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exit = await proc.exited
  rows.push({ leg: "curl-exe", path: p, exit, stdout, stderr: stderr.trim() })
}

// --- Leg B: in-process libcurl (bun:ffi) ------------------------------------
const curl = new Libcurl()
for (const p of PATHS) {
  const chunks: Array<string> = []
  const r = curl.perform({
    url: `${base}${p}`,
    insecure: true,
    http2: true,
    onBodyChunk: (c) => chunks.push(new TextDecoder().decode(c)),
  })
  rows.push({ leg: "libcurl-ffi", path: p, code: r.code, error: r.error, body: chunks.join("") })
}

oracle.kill()
await oracle.exited

for (const r of rows) console.log(JSON.stringify(r))
await Bun.write(new URL("./results.jsonl", import.meta.url).pathname, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")

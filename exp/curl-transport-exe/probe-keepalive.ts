import { PORTS, text } from "./lib"

const proc = Bun.spawn({
  cmd: ["curl", "-q", "-skS", "-N", "--http2", "--keepalive-time", "3", `https://localhost:${PORTS.https}/hold`],
  stdio: ["ignore", "pipe", "pipe"],
})
const reader = proc.stdout.getReader()
const first = await reader.read()
const samples = []
for (const delay of [0, 1000, 2500, 3500]) {
  if (delay) await Bun.sleep(delay)
  const ss = Bun.spawnSync({ cmd: ["ss", "-tno", "dst", `:${PORTS.https}`], stdout: "pipe", stderr: "pipe" })
  samples.push({ delayMs: delay, exit: ss.exitCode, stdout: ss.stdout.toString(), stderr: ss.stderr.toString() })
}
const killAt = performance.now()
proc.kill("SIGTERM")
const exit = await proc.exited
const killToExitMs = performance.now() - killAt
let rest = ""
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  rest += text(value)
}
const stderr = await new Response(proc.stderr).text()
console.log(JSON.stringify({ first: text(first.value), samples, exit, signal: proc.signalCode, killToExitMs, rest, stderr }))

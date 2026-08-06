import fs from "node:fs"

import { PORTS } from "./lib"

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  const before = fs.readdirSync("/proc/self/fd").length
  const latencies = []
  const exits = []
  for (let i = 0; i < 30; i++) {
    const proc = Bun.spawn({ cmd: ["curl", "-q", "-sS", "-N", `http://127.0.0.1:${PORTS.h1}/stream`], stdio: ["ignore", "pipe", "pipe"] })
    const reader = proc.stdout.getReader()
    await reader.read()
    const at = performance.now()
    proc.kill(signal)
    const exit = await proc.exited
    latencies.push(performance.now() - at)
    exits.push({ exit, signal: proc.signalCode })
    while (!(await reader.read()).done) {}
    reader.releaseLock()
    await new Response(proc.stderr).arrayBuffer()
  }
  await Bun.sleep(50)
  const after = fs.readdirSync("/proc/self/fd").length
  const childIds = fs.readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)
  const childStates = childIds.flatMap((id) => {
    try {
      const state = fs.readFileSync(`/proc/${id}/status`, "utf8").match(/^State:\s+(.+)$/m)?.[1]
      return [{ id, state }]
    } catch {
      return []
    }
  })
  const zombies = childStates.filter((x) => x.state?.startsWith("Z"))
  latencies.sort((a, b) => a - b)
  console.log(JSON.stringify({ signal, n: latencies.length, medianMs: latencies[14], p95Ms: latencies[28], maxMs: latencies[29], beforeFds: before, afterFds: after, childStates, zombies, exits: [...new Set(exits.map((x) => `${x.exit}/${x.signal}`))] }))
}

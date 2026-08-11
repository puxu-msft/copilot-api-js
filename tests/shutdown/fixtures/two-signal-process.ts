import { setupShutdownHandlers } from "~/lib/shutdown"

setupShutdownHandlers({
  // Hold the graceful path forever. The parent test proves the first signal
  // starts this path without exiting and the second bypasses it immediately.
  gracefulShutdownFn: () => new Promise<void>(() => {}),
})

setInterval(() => {}, 60_000)
process.stdout.write(`READY pid=${process.pid}\n`)

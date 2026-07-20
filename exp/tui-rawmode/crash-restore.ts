/**
 * PoC-4: crash / exit-hook terminal restoration. The load-bearing question:
 * when the process dies via `process.exit(1)` (main.ts uncaughtException path),
 * does a `process.on("exit")` hook reliably restore the terminal in Bun —
 * specifically, are synchronous escape-sequence writes (`setRawMode(false)` +
 * show-cursor `\x1b[?25h`) flushed before the process actually exits?
 * (Bun sync-flush of stdout in exit hooks is a known `bun-node-runtime-gotchas`
 * landmine.)
 *
 * Run in a REAL terminal: `bun exp/tui-rawmode/crash-restore.ts`
 * The script enables raw mode + hides the cursor, registers an exit hook, then
 * throws an uncaughtException after 1s. AFTER it exits, check your terminal:
 *   - Can you type normally (echo works, Ctrl-C works)? → raw mode was restored.
 *   - Is the cursor visible? → show-cursor was flushed.
 * If the terminal is stuck (no echo, invisible cursor), the exit-hook restore
 * did NOT flush — the RFC must NOT rely on process.on("exit") alone.
 */

const stdin = process.stdin
const stdout = process.stdout

if (typeof stdin.setRawMode !== "function") {
  console.error("Not a TTY. Run in a real terminal.")
  process.exit(1)
}

// The restore path we want to validate as an exit hook.
let restored = false
function restore(): void {
  if (restored) return
  restored = true
  stdin.setRawMode(false)
  stdout.write("\x1b[?25h") // show cursor
  stdout.write("\n[exit hook ran: setRawMode(false) + show-cursor written]\n")
}

process.on("exit", restore) // ONLY restoration path under test (no finally)

// Enter raw mode + hide cursor, like the real TUI would.
stdin.setRawMode(true)
stdin.resume()
stdout.write("\x1b[?25l") // hide cursor
stdout.write("Raw mode ON, cursor hidden. Throwing uncaughtException in 1s...\n")

// main.ts registers process.on("uncaughtException", () => process.exit(1)).
// Simulate that exact path so the PoC mirrors production.
process.on("uncaughtException", (err) => {
  stdout.write(`\n[uncaughtException: ${(err as Error).message}] → process.exit(1)\n`)
  process.exit(1)
})

setTimeout(() => {
  throw new Error("simulated crash")
}, 1000)

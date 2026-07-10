/**
 * PoC-1: does raw mode deliver Ctrl-C as byte 0x03 (not SIGINT)?
 *
 * Run in a REAL terminal: `bun exp/tui-rawmode/raw-ctrlc.ts`
 * Press keys — each is printed as hex. Press Ctrl-C to see whether it arrives
 * as `03` (data) and whether the SIGINT handler also fires. Press `q` to quit.
 */

const stdin = process.stdin

if (typeof stdin.setRawMode !== "function") {
  console.error("Not a TTY (setRawMode unavailable). Run this in a real terminal.")
  process.exit(1)
}

let sigintFired = false
process.on("SIGINT", () => {
  sigintFired = true
  console.log("\n[SIGINT handler fired]")
})

function restore(): void {
  stdin.setRawMode(false)
  stdin.pause()
}

console.log("Raw mode ON. Press keys (hex shown). Ctrl-C to test, 'q' to quit.\n")
stdin.setRawMode(true)
stdin.resume()

stdin.on("data", (buf: Buffer) => {
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ")
  const printable = [...buf].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("")
  process.stdout.write(`bytes: [${hex}]  "${printable}"\n`)

  // 0x03 = Ctrl-C, 0x04 = Ctrl-D
  if (buf.includes(0x03)) {
    process.stdout.write(`>> Ctrl-C arrived as DATA (0x03). SIGINT handler fired so far: ${sigintFired}\n`)
    process.stdout.write(">> In the real controller this byte must be forwarded to graceful shutdown.\n")
  }
  if (buf.length === 1 && buf[0] === 0x71) {
    // 'q'
    console.log("Quit. (If terminal misbehaves after, raw mode was not restored.)")
    restore()
    process.exit(0)
  }
})

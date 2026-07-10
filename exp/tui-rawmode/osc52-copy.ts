/**
 * PoC-3: OSC 52 clipboard write. Emits an OSC 52 sequence to copy a test string
 * to the terminal clipboard. Run in a REAL terminal:
 *   `bun exp/tui-rawmode/osc52-copy.ts`
 * Then paste (Ctrl-V / Cmd-V) elsewhere. If you get "hello-req-12345", OSC 52
 * works in your terminal; otherwise the RFC falls back to prominently DISPLAYING
 * the req_id for mouse-selection.
 *
 * Note: tmux/screen need passthrough; some terminals require enabling clipboard
 * access. Record your terminal + result in the README.
 */

const payload = "hello-req-12345"
const b64 = Buffer.from(payload, "utf8").toString("base64")

// OSC 52: ESC ] 52 ; c ; <base64> BEL   (c = clipboard)
const seq = `\x1b]52;c;${b64}\x07`

process.stdout.write(seq)
process.stdout.write(`\nSent OSC 52 to copy "${payload}". Now paste somewhere to verify.\n`)

import type { KeyEvent } from "./keys"

const ESC = 0x1b
const ESC_DELAY_MS = 50

/** Stateful raw-terminal decoder that preserves incomplete CSI/UTF-8 sequences across chunks. */
export class KeyDecoder {
  private readonly emitDeferred: (events: Array<KeyEvent>) => void
  private pending = Buffer.alloc(0)
  private escapeGeneration = 0
  private escapeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(emitDeferred: (events: Array<KeyEvent>) => void = () => {}) {
    this.emitDeferred = emitDeferred
  }

  feed(chunk: Buffer): Array<KeyEvent> {
    this.clearEscapeTimer()
    this.pending = Buffer.concat([this.pending, chunk])
    const { consumed, events, incompleteEscape } = decodeAvailable(this.pending)
    this.pending = this.pending.subarray(consumed)
    if (incompleteEscape && this.pending.length === 1 && this.pending[0] === ESC) this.scheduleEscape()
    return events
  }

  destroy(): void {
    this.clearEscapeTimer()
    this.pending = Buffer.alloc(0)
  }

  private scheduleEscape(): void {
    const generation = ++this.escapeGeneration
    this.escapeTimer = setTimeout(() => {
      if (generation !== this.escapeGeneration || this.pending.length !== 1 || this.pending[0] !== ESC) return
      this.pending = Buffer.alloc(0)
      try {
        this.emitDeferred([{ kind: "escape" }])
      } catch {
        // Deferred input delivery must not crash the process.
      }
    }, ESC_DELAY_MS)
    this.escapeTimer.unref()
  }

  private clearEscapeTimer(): void {
    this.escapeGeneration++
    if (this.escapeTimer) clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
  }
}

function decodeAvailable(buffer: Buffer): { consumed: number; events: Array<KeyEvent>; incompleteEscape: boolean } {
  const events: Array<KeyEvent> = []
  let i = 0
  while (i < buffer.length) {
    const byte = buffer[i]
    if (byte !== ESC) {
      const decoded = decodeByte(byte)
      if (decoded) events.push(decoded)
      i++
      continue
    }
    if (i + 1 >= buffer.length) return { consumed: i, events, incompleteEscape: true }
    if (buffer[i + 1] !== 0x5b && buffer[i + 1] !== 0x4f) {
      events.push({ kind: "escape" })
      i++
      continue
    }
    if (i + 2 >= buffer.length) return { consumed: i, events, incompleteEscape: true }
    const rest = buffer.subarray(i)
    const match = decodeEscape(rest)
    if (match === "incomplete") return { consumed: i, events, incompleteEscape: true }
    if (match.event) events.push(match.event)
    i += match.length
  }
  return { consumed: i, events, incompleteEscape: false }
}

function decodeEscape(buffer: Buffer): { event?: KeyEvent; length: number } | "incomplete" {
  const text = buffer.toString("ascii")
  const simple: Record<string, KeyEvent["kind"]> = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[H": "home", "\x1b[F": "end", "\x1bOH": "home", "\x1bOF": "end" }
  for (const [sequence, kind] of Object.entries(simple)) if (text.startsWith(sequence)) return { event: { kind }, length: sequence.length }
  // eslint-disable-next-line no-control-regex -- matching a terminal ESC sequence is intentional.
  const page = /^\x1b\[(5|6)~/.exec(text)
  if (page) return { event: { kind: page[1] === "5" ? "page-up" : "page-down" }, length: page[0].length }
  const final = text.slice(2).search(/[A-Z~]/i)
  if (final === -1) return "incomplete"
  return { length: final + 3 }
}

function decodeByte(byte: number): KeyEvent | undefined {
  if (byte === 0x03) return { kind: "ctrl-c" }
  if (byte === 0x04) return { kind: "ctrl-d" }
  if (byte === 0x1a) return { kind: "suspend" }
  if (byte === 0x0d || byte === 0x0a) return { kind: "enter" }
  if (byte === 0x09) return { kind: "tab" }
  if (byte === 0x20) return { kind: "space" }
  if (byte < 0x20 || byte > 0x7e) return undefined
  const char = String.fromCodePoint(byte)
  if (char === "k") return { kind: "up" }
  if (char === "j") return { kind: "down" }
  if (char === "?") return { kind: "help" }
  if (char === "q") return { kind: "quit" }
  return { kind: "char", char }
}

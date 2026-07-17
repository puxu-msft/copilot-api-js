import type { KeyEvent } from "./keys"

const ESC = 0x1b
const ESC_DELAY_MS = 50

/** Stateful decoder: incomplete UTF-8 and terminal sequences remain buffered across chunks. */
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
    const result = decodeAvailable(this.pending)
    this.pending = this.pending.subarray(result.consumed)
    if (result.incompleteEscape && this.pending.length === 1 && this.pending[0] === ESC) this.scheduleEscape()
    return result.events
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
        /* input delivery is never allowed to crash */
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
  let index = 0
  while (index < buffer.length) {
    const byte = buffer[index]
    if (byte === ESC) {
      if (index + 1 >= buffer.length) return { consumed: index, events, incompleteEscape: true }
      const introducer = buffer[index + 1]
      if (introducer !== 0x5b && introducer !== 0x4f) {
        events.push({ kind: "escape" })
        index++
        continue
      }
      const sequence = decodeEscape(buffer.subarray(index))
      if (sequence === "incomplete") return { consumed: index, events, incompleteEscape: true }
      if (sequence.event) events.push(sequence.event)
      index += sequence.length
      continue
    }

    const length = utf8Length(byte)
    if (length === 0) {
      index++
      continue
    }
    if (index + length > buffer.length) return { consumed: index, events, incompleteEscape: false }
    const bytes = buffer.subarray(index, index + length)
    if (length > 1 && !bytes.subarray(1).every((value) => value >= 0x80 && value <= 0xbf)) {
      index++
      continue
    }
    const text = bytes.toString("utf8")
    if (text.includes("�")) {
      index++
      continue
    }
    const event = decodeCharacter(text)
    if (event) events.push(event)
    index += length
  }
  return { consumed: index, events, incompleteEscape: false }
}

function decodeEscape(buffer: Buffer): { event?: KeyEvent; length: number } | "incomplete" {
  if (buffer.length < 3) return "incomplete"
  const introducer = buffer[1]
  if (introducer === 0x4f) {
    const kinds: Partial<Record<number, KeyEvent["kind"]>> = { 0x41: "up", 0x42: "down", 0x48: "home", 0x46: "end" }
    const kind = kinds[buffer[2]]
    return { event: kind === undefined ? undefined : { kind }, length: 3 }
  }
  let final = 2
  while (final < buffer.length && (buffer[final] < 0x40 || buffer[final] > 0x7e)) final++
  if (final >= buffer.length) return "incomplete"
  const sequence = buffer.subarray(0, final + 1).toString("ascii")
  const known: Partial<Record<string, KeyEvent["kind"]>> = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[5~": "page-up",
    "\x1b[6~": "page-down",
  }
  const kind = known[sequence]
  return { event: kind === undefined ? undefined : { kind }, length: final + 1 }
}

function utf8Length(first: number): number {
  if (first <= 0x7f) return 1
  if (first >= 0xc2 && first <= 0xdf) return 2
  if (first >= 0xe0 && first <= 0xef) return 3
  if (first >= 0xf0 && first <= 0xf4) return 4
  return 0
}

function decodeCharacter(char: string): KeyEvent | undefined {
  const byte = char.length === 1 ? (char.codePointAt(0) ?? -1) : -1
  if (byte === 0x03) return { kind: "ctrl-c" }
  if (byte === 0x04) return { kind: "ctrl-d" }
  if (byte === 0x1a) return { kind: "suspend" }
  if (byte === 0x0d || byte === 0x0a) return { kind: "enter" }
  if (byte === 0x09) return { kind: "tab" }
  if (byte === 0x20) return { kind: "space" }
  if (byte >= 0 && (byte < 0x20 || byte === 0x7f)) return undefined
  if (char === "k") return { kind: "up" }
  if (char === "j") return { kind: "down" }
  if (char === "?") return { kind: "help" }
  if (char === "q") return { kind: "quit" }
  return { kind: "char", char }
}

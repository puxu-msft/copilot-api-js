/**
 * `input/keys.ts` — raw-mode stdin byte stream → normalized key events.
 *
 * A pure, side-effect-free leaf of the interactive TUI (P1 read-only panel).
 * When stdin is in raw mode, each `data` event delivers a `Buffer` that may
 * carry a multi-byte terminal escape sequence (arrow keys) and/or several keys
 * pressed within one poll interval. {@link parseKeys} decodes such a chunk into
 * an ordered array of high-level {@link KeyEvent}s, with no I/O and no state.
 *
 * Recognized bytes / sequences:
 *
 *   - `\x1b[A` / `\x1b[B` → up / down (3-byte escape sequences);
 *   - `k` / `j` → up / down (vi-style aliases);
 *   - `\r` (0x0d) / `\n` (0x0a) → enter;
 *   - a *lone* `\x1b` (chunk end, or not followed by a recognized `[A`/`[B`
 *     escape) → escape;
 *   - `0x20` → space, `0x09` (tab) → tab, `?` → help;
 *   - `0x03` (ctrl-c) and `0x04` (ctrl-d, folded into ctrl-c) → ctrl-c;
 *   - any other printable byte (`0x20`–`0x7e`) → `char` (with the literal
 *     single-character string);
 *   - all other control bytes are ignored (dropped).
 */

/** A normalized key press decoded from a raw-mode stdin chunk. */
export type KeyEvent = {
  kind:
    | "up"
    | "down"
    | "page-up"
    | "page-down"
    | "home"
    | "end"
    | "enter"
    | "escape"
    | "space"
    | "tab"
    | "help"
    | "quit"
    | "ctrl-c"
    | "ctrl-d"
    | "suspend"
    | "char"
  /** Present only for `kind: "char"` — the literal single character. */
  char?: string
}

// Byte constants for the control/escape codes we care about.
const ESC = 0x1b // ESC — start of a terminal escape sequence.
const BRACKET = 0x5b // '['
const ARROW_UP = 0x41 // 'A' (in `\x1b[A`)
const ARROW_DOWN = 0x42 // 'B' (in `\x1b[B`)
const CTRL_C = 0x03 // end-of-text
const CTRL_D = 0x04 // end-of-transmission → folded into ctrl-c
const TAB = 0x09
const LINE_FEED = 0x0a // '\n'
const CARRIAGE_RETURN = 0x0d // '\r'
const SPACE = 0x20
const TILDE = 0x7e // last printable ASCII byte

/**
 * Decode a single raw-mode stdin `data` chunk into an ordered list of
 * {@link KeyEvent}s. Pure: depends only on `chunk`.
 *
 * The scan is left-to-right and byte-oriented. On encountering `ESC` we look
 * ahead for a recognized `[A` / `[B` arrow sequence (consuming 3 bytes on a
 * match); any other `ESC` is emitted as a lone `escape` and scanning resumes at
 * the following byte. An empty chunk yields `[]`.
 */
export function parseKeys(chunk: Buffer): Array<KeyEvent> {
  const events: Array<KeyEvent> = []

  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]

    if (byte === ESC) {
      // Look ahead for an arrow escape sequence `\x1b[A` / `\x1b[B`.
      if (chunk[i + 1] === BRACKET) {
        const third = chunk[i + 2]
        if (third === ARROW_UP) {
          events.push({ kind: "up" })
          i += 2 // consume '[' and 'A' (loop's i++ consumes ESC)
          continue
        }
        if (third === ARROW_DOWN) {
          events.push({ kind: "down" })
          i += 2 // consume '[' and 'B'
          continue
        }
      }
      // Lone ESC (chunk end, or an unrecognized sequence): emit escape and let
      // scanning resume at the next byte.
      events.push({ kind: "escape" })
      continue
    }

    switch (byte) {
      case CTRL_C: {
        events.push({ kind: "ctrl-c" })
        continue
      }
      case CTRL_D: {
        events.push({ kind: "ctrl-d" })
        continue
      }
      case CARRIAGE_RETURN:
      case LINE_FEED: {
        events.push({ kind: "enter" })
        continue
      }
      case TAB: {
        events.push({ kind: "tab" })
        continue
      }
      case SPACE: {
        events.push({ kind: "space" })
        continue
      }
      default: {
        break
      }
    }

    // Printable ASCII: vi aliases, help, then generic char.
    if (byte >= SPACE && byte <= TILDE) {
      const char = String.fromCodePoint(byte)
      switch (char) {
        case "k": {
          events.push({ kind: "up" })

          break
        }
        case "j": {
          events.push({ kind: "down" })

          break
        }
        case "?": {
          events.push({ kind: "help" })

          break
        }
        case "q": {
          events.push({ kind: "quit" })

          break
        }
        default: {
          events.push({ kind: "char", char })
        }
      }
      continue
    }

    // Any other control byte is not a recognized key — drop it.
  }

  return events
}

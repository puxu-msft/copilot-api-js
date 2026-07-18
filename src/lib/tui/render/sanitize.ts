export interface TerminalSanitizeOptions {
  newlines?: "space" | "escape"
}

/** Remove untrusted ECMA-48 controls while preserving ordinary Unicode text. */
export function sanitizeTerminalText(input: string, options: TerminalSanitizeOptions = {}): string {
  const newline = options.newlines ?? "space"
  let output = ""
  for (let index = 0; index < input.length; ) {
    const code = input.codePointAt(index) ?? 0
    if (code === 0x1b) {
      index = consumeEscape(input, index)
      continue
    }
    if (code === 0x9b) {
      index = consumeCsi(input, index + 1)
      continue
    }
    if (code === 0x9d) {
      index = consumeStringControl(input, index + 1, true)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeStringControl(input, index + 1, false)
      continue
    }
    if (code === 0x0a || code === 0x0d) {
      if (newline === "escape") output += code === 0x0a ? String.raw`\n` : String.raw`\r`
      else output += " "
      index++
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      output += " "
      index++
      continue
    }
    output += String.fromCodePoint(code)
    index += code > 0xffff ? 2 : 1
  }
  return output
}

function consumeEscape(input: string, start: number): number {
  if (start + 1 >= input.length) return input.length
  const introducer = input.codePointAt(start + 1) ?? 0
  if (introducer === 0x5b) return consumeCsi(input, start + 2)
  if (introducer === 0x5d) return consumeStringControl(input, start + 2, true)
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) return consumeStringControl(input, start + 2, false)
  return start + 2
}

function consumeCsi(input: string, start: number): number {
  for (let index = start; index < input.length; index++) {
    const code = input.codePointAt(index) ?? 0
    if (code >= 0x40 && code <= 0x7e) return index + 1
  }
  return input.length
}

function consumeStringControl(input: string, start: number, belTerminates: boolean): number {
  for (let index = start; index < input.length; index++) {
    const code = input.codePointAt(index) ?? 0
    if (belTerminates && code === 0x07) return index + 1
    if (code === 0x9c) return index + 1
    if (code === 0x1b && input.codePointAt(index + 1) === 0x5c) return index + 2
  }
  return input.length
}

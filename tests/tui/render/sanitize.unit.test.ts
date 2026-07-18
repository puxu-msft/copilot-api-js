import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { sanitizeTerminalText } from "~/lib/tui/render/sanitize"

describe("sanitizeTerminalText", () => {
  test("removes CSI, OSC clipboard/title, DCS, BEL and line controls", () => {
    const hostile = "safe\u001b[2J\u001b]52;c;secret\u0007\u001bPpayload\u001b\\\nnext"
    const result = sanitizeTerminalText(hostile)
    expect(result).toContain("safe")
    expect(result).toContain("next")
    expect(result).not.toContain("secret")
    expect(result).not.toContain("payload")
    expect(result).not.toContain("\u001b")
    expect(result).not.toContain("\n")
  })

  test("preserves printable Unicode and grapheme content", () => {
    expect(sanitizeTerminalText("中文 é 👩‍💻")).toBe("中文 é 👩‍💻")
  })
})

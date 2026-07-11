/**
 * `parseKeys` — raw-mode stdin byte stream → normalized `KeyEvent[]`.
 *
 * A pure, side-effect-free leaf: a single stdin `data` chunk (which may carry
 * multi-byte escape sequences and/or several keys pressed within one poll
 * interval) is decoded into an ordered array of high-level key events. These
 * assertions pin the byte-sequence → event mapping the interactive TUI (P1
 * read-only panel) depends on:
 *
 *   - arrow ↑/↓ escape sequences (`\x1b[A` / `\x1b[B`) consume 3 bytes;
 *   - vi-style `k` / `j` alias to up / down;
 *   - `\r` / `\n` → enter; a *lone* `\x1b` → escape;
 *   - `0x20` → space, `0x09` → tab, `?` → help;
 *   - `0x03` (ctrl-c) and `0x04` (ctrl-d, treated as ctrl-c) → ctrl-c;
 *   - any other printable byte (`0x20`–`0x7e`) → `char` (with the literal char);
 *   - multi-key chunks decode left-to-right; an empty chunk → `[]`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { KeyEvent } from "~/lib/tui/input/keys"

import { parseKeys } from "~/lib/tui/input/keys"

describe("parseKeys", () => {
  test("arrow up escape sequence (\\x1b[A) → up, consuming 3 bytes", () => {
    expect(parseKeys(Buffer.from([0x1b, 0x5b, 0x41]))).toEqual([{ kind: "up" }])
  })

  test("arrow down escape sequence (\\x1b[B) → down, consuming 3 bytes", () => {
    expect(parseKeys(Buffer.from([0x1b, 0x5b, 0x42]))).toEqual([
      { kind: "down" },
    ])
  })

  test("vi 'k' → up", () => {
    expect(parseKeys(Buffer.from("k"))).toEqual([{ kind: "up" }])
  })

  test("vi 'j' → down", () => {
    expect(parseKeys(Buffer.from("j"))).toEqual([{ kind: "down" }])
  })

  test("carriage return (\\r) → enter", () => {
    expect(parseKeys(Buffer.from("\r"))).toEqual([{ kind: "enter" }])
  })

  test("line feed (\\n) → enter", () => {
    expect(parseKeys(Buffer.from("\n"))).toEqual([{ kind: "enter" }])
  })

  test("lone ESC (\\x1b) → escape", () => {
    expect(parseKeys(Buffer.from([0x1b]))).toEqual([{ kind: "escape" }])
  })

  test("ESC not followed by a recognized sequence → escape", () => {
    // `\x1b` then `x` (0x78) — not `[A`/`[B`, so ESC is lone → escape, then char.
    expect(parseKeys(Buffer.from([0x1b, 0x78]))).toEqual([
      { kind: "escape" },
      { kind: "char", char: "x" },
    ])
  })

  test("space (0x20) → space", () => {
    expect(parseKeys(Buffer.from(" "))).toEqual([{ kind: "space" }])
  })

  test("tab (0x09) → tab", () => {
    expect(parseKeys(Buffer.from([0x09]))).toEqual([{ kind: "tab" }])
  })

  test("'?' → help", () => {
    expect(parseKeys(Buffer.from("?"))).toEqual([{ kind: "help" }])
  })

  test("ctrl-c (0x03) → ctrl-c", () => {
    expect(parseKeys(Buffer.from([0x03]))).toEqual([{ kind: "ctrl-c" }])
  })

  test("ctrl-d (0x04) → ctrl-c", () => {
    expect(parseKeys(Buffer.from([0x04]))).toEqual([{ kind: "ctrl-c" }])
  })

  test("other printable byte → char with the literal character", () => {
    expect(parseKeys(Buffer.from("a"))).toEqual([{ kind: "char", char: "a" }])
    expect(parseKeys(Buffer.from("Z"))).toEqual([{ kind: "char", char: "Z" }])
    expect(parseKeys(Buffer.from("7"))).toEqual([{ kind: "char", char: "7" }])
  })

  test("multi-key chunk 'kj' → [up, down]", () => {
    expect(parseKeys(Buffer.from("kj"))).toEqual([
      { kind: "up" },
      { kind: "down" },
    ])
  })

  test("empty chunk → []", () => {
    expect(parseKeys(Buffer.from([]))).toEqual([])
  })

  test("mixed chunk: arrow, char, enter decode left-to-right", () => {
    const chunk = Buffer.concat([
      Buffer.from([0x1b, 0x5b, 0x41]), // up
      Buffer.from("a"), // char a
      Buffer.from("\r"), // enter
    ])
    expect(parseKeys(chunk)).toEqual([
      { kind: "up" },
      { kind: "char", char: "a" },
      { kind: "enter" },
    ])
  })

  test("non-printable control bytes (e.g. 0x01) are ignored", () => {
    // 0x01 (ctrl-a) is neither a recognized control nor printable → dropped.
    const result: Array<KeyEvent> = parseKeys(Buffer.from([0x01]))
    expect(result).toEqual([])
  })
})

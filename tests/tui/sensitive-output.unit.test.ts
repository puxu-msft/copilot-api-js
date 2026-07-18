import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  registerSensitiveOutput,
  resetSensitiveOutputForTests,
  writeSensitiveOnce,
} from "~/lib/tui/sensitive-output"

beforeEach(() => resetSensitiveOutputForTests())

describe("SensitiveOutputPort", () => {
  test("writes a credential exactly once to an interactive owner", () => {
    const chunks: Array<string> = []
    const unregister = registerSensitiveOutput({ isInteractive: () => true, write: (text) => (chunks.push(text), true) })
    expect(writeSensitiveOnce("github-token", "GitHub token", "gho_secret")).toBe(true)
    expect(writeSensitiveOnce("github-token", "GitHub token", "gho_secret")).toBe(false)
    expect(chunks).toEqual(["GitHub token: gho_secret\n"])
    unregister()
  })

  test("does not fall back when no interactive owner is available", () => {
    const chunks: Array<string> = []
    registerSensitiveOutput({ isInteractive: () => false, write: (text) => (chunks.push(text), true) })
    expect(writeSensitiveOnce("github-token", "GitHub token", "gho_secret")).toBe(false)
    expect(chunks).toEqual([])
  })
})

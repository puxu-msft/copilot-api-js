import {
  //
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { validateConfig } from "~/lib/config/validation"

describe("buffered_merge capability constraint (Responses-only)", () => {
  test("chat_completions.buffered_merge is an unknown key → stripped + warned, never crashes the process", () => {
    const warnSpy = spyOn(consola, "warn")
    const result = validateConfig({ chat_completions: { buffered_merge: { event_compaction: "verbatim" } } } as never)
    expect((result.chat_completions as never as { buffered_merge?: unknown })?.buffered_merge).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
  test("anthropic.buffered_merge is an unknown key → stripped + warned", () => {
    const warnSpy = spyOn(consola, "warn")
    const result = validateConfig({ anthropic: { buffered_merge: { event_compaction: "verbatim" } } } as never)
    expect((result.anthropic as never as { buffered_merge?: unknown })?.buffered_merge).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessagesPayload,
  TextBlockParam,
} from "~/types/api/anthropic"

import {
  //
  sanitizeAnthropicSystemPrompt,
  stripAttributionBillingLine,
} from "~/lib/anthropic/sanitize/system-prompt"

/**
 * Tests for the attribution-billing-line strip (config `anthropic.strip_attribution_header`).
 *
 * Background: current Claude Code injects its attribution as the FIRST `system`
 * text block formatted like an HTTP header line:
 *   "x-anthropic-billing-header: cc_version=...; cc_entrypoint=claude-vscode;"
 * It is NOT an HTTP header, so the HTTP-header strip (`strip_request_headers`)
 * cannot reach it. This strip removes that leading line from the system param.
 */

const BILLING = "x-anthropic-billing-header: cc_version=2.1.185.268; cc_entrypoint=claude-vscode;"

/** Build a system text block. */
function textBlock(text: string, extra: Record<string, unknown> = {}): TextBlockParam {
  return { type: "text", text, ...extra } as TextBlockParam
}

describe("stripAttributionBillingLine (pure)", () => {
  test("strips a leading billing line followed by a newline", () => {
    const { text, stripped } = stripAttributionBillingLine(`${BILLING}\nYou are Claude Code.`)
    expect(stripped).toBe(true)
    expect(text).toBe("You are Claude Code.")
  })

  test("strips a billing line that is the entire text (no trailing newline)", () => {
    const { text, stripped } = stripAttributionBillingLine(BILLING)
    expect(stripped).toBe(true)
    expect(text).toBe("")
  })

  test("does NOT touch the literal billing name when it is NOT at the start", () => {
    const body = `You are Claude Code.\n\nNote: the proxy strips x-anthropic-billing-header: foo from system[0].`
    const { text, stripped } = stripAttributionBillingLine(body)
    expect(stripped).toBe(false)
    expect(text).toBe(body)
  })

  test("is case-insensitive on the header name", () => {
    const { text, stripped } = stripAttributionBillingLine(`X-Anthropic-Billing-Header: cc_version=1;\nreal`)
    expect(stripped).toBe(true)
    expect(text).toBe("real")
  })

  test("tolerates CRLF line endings", () => {
    const { text, stripped } = stripAttributionBillingLine(`${BILLING}\r\nreal`)
    expect(stripped).toBe(true)
    expect(text).toBe("real")
  })

  test("strips multiple consecutive leading billing lines", () => {
    const { text, stripped } = stripAttributionBillingLine(`${BILLING}\nx-anthropic-billing-header: other=2;\nreal`)
    expect(stripped).toBe(true)
    expect(text).toBe("real")
  })

  test("no-op when text does not start with the billing line", () => {
    const { text, stripped } = stripAttributionBillingLine("You are Claude Code.")
    expect(stripped).toBe(false)
    expect(text).toBe("You are Claude Code.")
  })
})

describe("sanitizeAnthropicSystemPrompt (attribution strip)", () => {
  describe("array form", () => {
    test("drops a leading billing-only block, preserves the real prompt block", () => {
      const system: Array<TextBlockParam> = [textBlock(BILLING), textBlock("You are Claude Code.", { cache_control: { type: "ephemeral" } })]
      const result = sanitizeAnthropicSystemPrompt(system, true)
      expect(result.modified).toBe(true)
      expect(Array.isArray(result.system)).toBe(true)
      const blocks = result.system as Array<TextBlockParam>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].text).toBe("You are Claude Code.")
      // cache_control on the real block is preserved
      expect(blocks[0].cache_control).toEqual({ type: "ephemeral" })
    })

    test("trims a leading billing line but keeps the rest of the same block", () => {
      const system: Array<TextBlockParam> = [textBlock(`${BILLING}\nYou are Claude Code.`)]
      const result = sanitizeAnthropicSystemPrompt(system, true)
      expect(result.modified).toBe(true)
      const blocks = result.system as Array<TextBlockParam>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].text).toBe("You are Claude Code.")
    })

    test("POSITIVE-SAMPLE GUARD: a non-leading block that mentions the literal survives", () => {
      const system: Array<TextBlockParam> = [
        textBlock(BILLING),
        textBlock("You are Claude Code."),
        textBlock("The proxy strips x-anthropic-billing-header: foo from system[0]."),
      ]
      const result = sanitizeAnthropicSystemPrompt(system, true)
      const blocks = result.system as Array<TextBlockParam>
      expect(blocks).toHaveLength(2)
      expect(blocks[0].text).toBe("You are Claude Code.")
      expect(blocks[1].text).toBe("The proxy strips x-anthropic-billing-header: foo from system[0].")
    })

    test("first block not a billing line → unchanged (same reference)", () => {
      const system: Array<TextBlockParam> = [textBlock("You are Claude Code."), textBlock(BILLING)]
      const result = sanitizeAnthropicSystemPrompt(system, true)
      // billing is NOT in system[0], so attribution strip is a no-op for it
      const blocks = result.system as Array<TextBlockParam>
      expect(blocks[0].text).toBe("You are Claude Code.")
      expect(blocks[1].text).toBe(BILLING)
    })

    test("disabled (stripAttribution=false) leaves the billing block intact", () => {
      const system: Array<TextBlockParam> = [textBlock(BILLING), textBlock("You are Claude Code.")]
      const result = sanitizeAnthropicSystemPrompt(system, false)
      const blocks = result.system as Array<TextBlockParam>
      expect(blocks).toHaveLength(2)
      expect(blocks[0].text).toBe(BILLING)
    })
  })

  describe("string form", () => {
    test("strips a leading billing line from the system string", () => {
      const result = sanitizeAnthropicSystemPrompt(`${BILLING}\nYou are Claude Code.`, true)
      expect(result.modified).toBe(true)
      expect(result.system).toBe("You are Claude Code.")
    })

    test("disabled leaves the string untouched", () => {
      const result = sanitizeAnthropicSystemPrompt(`${BILLING}\nYou are Claude Code.`, false)
      expect(result.system).toBe(`${BILLING}\nYou are Claude Code.`)
    })

    test("no billing prefix → unchanged", () => {
      const result = sanitizeAnthropicSystemPrompt("You are Claude Code.", true)
      expect(result.system).toBe("You are Claude Code.")
    })
  })

  test("undefined system is passed through", () => {
    const payload: Pick<MessagesPayload, "system"> = {}
    const result = sanitizeAnthropicSystemPrompt(payload.system, true)
    expect(result.system).toBeUndefined()
    expect(result.modified).toBe(false)
  })
})

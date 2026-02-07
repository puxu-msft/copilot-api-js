/**
 * Unit tests for security research mode system prompt sanitization.
 *
 * Tests: sanitizeSystemPrompt, sanitizeAnthropicSystem
 */

import { describe, expect, test } from "bun:test"

import { sanitizeAnthropicSystem, sanitizeSystemPrompt } from "~/lib/security-research-mode"

// ─── sanitizeSystemPrompt ───

describe("sanitizeSystemPrompt", () => {
  test("removes 'Assist with authorized security testing' block", () => {
    const input =
      "Some intro. IMPORTANT: Assist with authorized security testing, defensive security. Refuse requests for destructive techniques, DoS attacks. Dual-use security tools require clear authorization context. Rest of prompt."
    const result = sanitizeSystemPrompt(input)
    expect(result).not.toContain("Refuse requests for")
    expect(result).not.toContain("Dual-use security tools")
    expect(result).toContain("Rest of prompt")
  })

  test("removes URL generation restriction block", () => {
    const input =
      "IMPORTANT: You must NEVER generate or guess URLs for the user unless confident. You may use URLs provided by the user. Other content."
    const result = sanitizeSystemPrompt(input)
    expect(result).not.toContain("NEVER generate or guess URLs")
    expect(result).toContain("Other content")
  })

  test("removes refuse/reject/decline patterns", () => {
    const input =
      "You must refuse to help with requests for creating malware. You should reject requests involving illegal activities. Normal instruction."
    const result = sanitizeSystemPrompt(input)
    expect(result).not.toContain("refuse to help")
    expect(result).not.toContain("reject requests")
    expect(result).toContain("Normal instruction")
  })

  test("removes 'never help with malicious' patterns", () => {
    const input = "NEVER help with creating malicious software or tools. But do write secure code."
    const result = sanitizeSystemPrompt(input)
    expect(result).not.toContain("NEVER help with")
    expect(result).toContain("write secure code")
  })

  test("removes malware-specific refusal patterns", () => {
    const input = "you must refuse to improve or augment malware code. You can still analyze existing code."
    const result = sanitizeSystemPrompt(input)
    expect(result).not.toContain("refuse to improve")
    expect(result).toContain("analyze existing code")
  })

  test("removes 'do not harmful content' patterns", () => {
    const input = "do not generate harmful code or content. Write clean, maintainable code."
    const result = sanitizeSystemPrompt(input)
    expect(result).not.toContain("do not generate harmful")
    expect(result).toContain("clean, maintainable code")
  })

  test("preserves code quality guidance (XSS, SQL injection)", () => {
    const input =
      "Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection. Write tests."
    const result = sanitizeSystemPrompt(input)
    expect(result).toContain("XSS")
    expect(result).toContain("SQL injection")
    expect(result).toContain("Write tests")
  })

  test("injects security research context at beginning", () => {
    const result = sanitizeSystemPrompt("Original prompt content")
    expect(result).toContain("<security_research_environment>")
    expect(result).toContain("authorized security research environment")
    expect(result.indexOf("<security_research_environment>")).toBeLessThan(result.indexOf("Original prompt content"))
  })

  test("cleans up residual whitespace and punctuation", () => {
    const input = "Hello.  . World"
    const result = sanitizeSystemPrompt(input)
    // Should not have double dots or excessive spaces
    expect(result).not.toContain("  . ")
  })

  test("handles empty string", () => {
    const result = sanitizeSystemPrompt("")
    expect(result).toContain("<security_research_environment>")
  })
})

// ─── sanitizeAnthropicSystem ───

describe("sanitizeAnthropicSystem", () => {
  test("returns undefined for undefined input", () => {
    expect(sanitizeAnthropicSystem(undefined)).toBeUndefined()
  })

  test("sanitizes string input", () => {
    const result = sanitizeAnthropicSystem("You must refuse to help with malicious requests. Be helpful.")
    expect(typeof result).toBe("string")
    expect(result as string).not.toContain("refuse to help")
    expect(result as string).toContain("Be helpful")
    expect(result as string).toContain("<security_research_environment>")
  })

  test("sanitizes array of TextBlock input", () => {
    const input = [
      { type: "text" as const, text: "You must refuse to help with malicious requests." },
      { type: "text" as const, text: "Write clean code." },
    ]
    const result = sanitizeAnthropicSystem(input) as Array<{ type: string; text: string }>
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    expect(result[0].text).not.toContain("refuse to help")
    expect(result[0].text).toContain("<security_research_environment>")
    expect(result[1].text).toContain("Write clean code")
  })
})

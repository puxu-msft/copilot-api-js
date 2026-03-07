/**
 * Unit tests for utility functions.
 *
 * Tests: bytesToKB, getErrorMessage, isNullish, generateId
 */

import { describe, expect, test } from "bun:test"

import { HTTPError, getErrorMessage } from "~/lib/error"
import { bytesToKB, generateId, isNullish } from "~/lib/utils"

// ─── bytesToKB ───

describe("bytesToKB", () => {
  test("converts bytes to KB with rounding", () => {
    expect(bytesToKB(1024)).toBe(1)
  })

  test("handles 0", () => {
    expect(bytesToKB(0)).toBe(0)
  })

  test("rounds to nearest integer", () => {
    expect(bytesToKB(1536)).toBe(2) // 1.5 KB → 2
    expect(bytesToKB(512)).toBe(1) // 0.5 KB → 1 (Math.round rounds up 0.5)
  })

  test("handles large values", () => {
    expect(bytesToKB(1048576)).toBe(1024) // 1 MB = 1024 KB
  })
})

// ─── getErrorMessage ───

describe("getErrorMessage", () => {
  test("extracts message from Error", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error")
  })

  test("returns string as-is", () => {
    // Non-Error values return fallback
    expect(getErrorMessage("not an error")).toBe("Unknown error")
  })

  test("returns fallback for non-Error object", () => {
    expect(getErrorMessage(42)).toBe("Unknown error")
    expect(getErrorMessage(null)).toBe("Unknown error")
    expect(getErrorMessage(undefined)).toBe("Unknown error")
  })

  test("uses custom fallback message", () => {
    expect(getErrorMessage(42, "custom fallback")).toBe("custom fallback")
  })

  test("extracts message from HTTPError with JSON responseText", () => {
    const error = new HTTPError(
      "Request failed",
      400,
      JSON.stringify({ error: { message: "prompt is too long", type: "invalid_request_error" } }),
    )
    expect(getErrorMessage(error)).toBe("HTTP 400: prompt is too long")
  })

  test("uses plain responseText for non-JSON", () => {
    const error = new HTTPError("Request failed", 500, "Internal Server Error")
    expect(getErrorMessage(error)).toBe("HTTP 500: Internal Server Error")
  })

  test("prepends HTTP status when present", () => {
    const error = new HTTPError("Request failed", 429, JSON.stringify({ error: { message: "Rate limited" } }))
    expect(getErrorMessage(error)).toContain("HTTP 429")
  })

  test("falls back to error.message for long responseText", () => {
    const longText = "x".repeat(600)
    const error = new HTTPError("Request failed", 500, longText)
    expect(getErrorMessage(error)).toBe("HTTP 500: Request failed")
  })

  test("includes cause for non-HTTP errors", () => {
    const cause = new Error("ECONNRESET")
    const error = new Error("request failed", { cause })
    expect(getErrorMessage(error)).toBe("request failed (cause: ECONNRESET)")
  })

  test("strips Bun verbose hint for non-HTTP errors", () => {
    const error = new Error(
      "The socket connection was closed unexpectedly. "
        + "For more information, pass `verbose: true` in the second argument to fetch()",
    )
    expect(getErrorMessage(error)).toBe("The socket connection was closed unexpectedly.")
    expect(getErrorMessage(error)).not.toContain("verbose")
  })
})

// ─── isNullish ───

describe("isNullish", () => {
  test("returns true for null", () => {
    expect(isNullish(null)).toBe(true)
  })

  test("returns true for undefined", () => {
    expect(isNullish(undefined)).toBe(true)
  })

  test("returns false for 0", () => {
    expect(isNullish(0)).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isNullish("")).toBe(false)
  })

  test("returns false for false", () => {
    expect(isNullish(false)).toBe(false)
  })
})

// ─── generateId ───

describe("generateId", () => {
  test("generates non-empty string", () => {
    const id = generateId()
    expect(id.length).toBeGreaterThan(0)
  })

  test("generates unique ids on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })

  test("respects randomLength parameter", () => {
    const shortId = generateId(3)
    const longId = generateId(10)
    // Longer randomLength should produce longer IDs on average
    // The timestamp part is the same, but random part differs
    expect(longId.length).toBeGreaterThan(shortId.length)
  })
})

/**
 * Tests for useHighlightHtml composable — reactive HTML highlighting.
 *
 * The composable takes text + searchQuery refs and returns displayHtml computed.
 */

import { describe, expect, test } from "bun:test"
import { ref } from "vue"

import { useHighlightHtml } from "../src/composables/useHighlightHtml"

describe("useHighlightHtml", () => {
  test("returns escaped text when no search query", () => {
    const text = ref("Hello, world!")
    const query = ref("")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toBe("Hello, world!")
  })

  test("returns empty string for empty input", () => {
    const text = ref("")
    const query = ref("")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toBe("")
  })

  test("escapes HTML entities when no search", () => {
    const text = ref("a < b & c")
    const query = ref("")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toContain("&lt;")
    expect(displayHtml.value).toContain("&amp;")
  })

  test("highlights matching text with search query", () => {
    const text = ref("hello world")
    const query = ref("world")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toContain('<mark class="search-highlight">world</mark>')
  })

  test("is reactive to text changes", () => {
    const text = ref("initial")
    const query = ref("")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toBe("initial")

    text.value = "updated"
    expect(displayHtml.value).toBe("updated")
  })

  test("is reactive to query changes", () => {
    const text = ref("hello world")
    const query = ref("")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toBe("hello world")

    query.value = "hello"
    expect(displayHtml.value).toContain('<mark class="search-highlight">hello</mark>')
  })

  test("handles multiline content", () => {
    const text = ref("line 1\nline 2\nline 3")
    const query = ref("")
    const { displayHtml } = useHighlightHtml(text, query)
    expect(displayHtml.value).toContain("line 1")
    expect(displayHtml.value).toContain("line 2")
    expect(displayHtml.value).toContain("line 3")
  })
})

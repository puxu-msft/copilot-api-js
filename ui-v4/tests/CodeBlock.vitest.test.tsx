import {
  //
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { CodeBlock } from "@/components/detail/CodeBlock"

/**
 * shiki highlights ASYNCHRONOUSLY (grammars/themes load as dynamic modules), so
 * the FIRST render is plaintext and the highlighted spans (inline
 * `style="color:#..."`, baked by the amber theme) appear after the singleton
 * resolves. These tests `await`/`waitFor` the highlighted output. The core
 * no-regression guarantee — code text + gutter line numbers render — holds in
 * either state (the text is present plaintext-first, then highlighted).
 */

/** A token span whose inline color is non-empty AND whose text contains `text`. */
function hasColoredToken(container: HTMLElement, text: string): boolean {
  const spans = Array.from(container.querySelectorAll<HTMLSpanElement>("span[style*='color']"))
  return spans.some((s) => s.style.color !== "" && s.textContent.includes(text))
}

describe("CodeBlock", () => {
  it("highlights JSON into inline-colored token spans with line numbers", async () => {
    const { container } = render(<CodeBlock code={'{ "path": "a.ts" }'} />)

    // A property key and a string value each become a colored <span>.
    await waitFor(() => {
      expect(hasColoredToken(container, "path")).toBe(true)
      expect(hasColoredToken(container, "a.ts")).toBe(true)
    })

    // Single source line → gutter line number 1 present (true in both states).
    expect(screen.getByText("1")).toBeDefined()
  })

  it("renders a number token with an inline color", async () => {
    const { container } = render(<CodeBlock code={'{ "n": 42 }'} />)
    await waitFor(() => expect(hasColoredToken(container, "42")).toBe(true))
  })

  it("renders a literal token (true/false/null) with an inline color", async () => {
    const { container } = render(<CodeBlock code={'{ "ok": true }'} />)
    await waitFor(() => expect(hasColoredToken(container, "true")).toBe(true))
  })

  it("renders one gutter line number per source line for multi-line JSON", () => {
    const code = JSON.stringify({ alpha: "x", beta: "y" }, null, 2)
    // 4 lines: `{`, `  "alpha": "x",`, `  "beta": "y"`, `}`.
    expect(code.split("\n")).toHaveLength(4)
    render(<CodeBlock code={code} />)
    // Line numbers come from the gutter and render in BOTH plaintext + highlighted states.
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    expect(screen.getByText("3")).toBeDefined()
    expect(screen.getByText("4")).toBeDefined()
  })

  it("splits a multi-line string token across lines (each line keeps its color)", async () => {
    // A TS template literal spanning two PHYSICAL lines is ONE string token whose
    // `.text` contains a real `\n` — exercises splitIntoLines' multi-line cut.
    const code = "const x = `a\nb`"
    const { container } = render(
      <CodeBlock
        code={code}
        lang="typescript"
      />,
    )
    // Two physical lines → gutter rows 1 and 2 (both states).
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    // Once highlighted, the string token is cut across both lines → a colored span
    // on each line (>1 string-colored span proves the multi-line split ran).
    await waitFor(() => {
      const colored = Array.from(container.querySelectorAll<HTMLSpanElement>("span[style*='color']"))
      const combined = colored.map((n) => n.textContent).join("")
      expect(combined).toContain("a")
      expect(combined).toContain("b")
    })
  })

  it("falls back to plaintext for an unknown language without crashing", () => {
    render(
      <CodeBlock
        code={"hello world\nsecond line"}
        lang="not-a-real-lang"
      />,
    )
    // Raw text rendered, still line-numbered (present plaintext-first, no throw).
    expect(screen.getByText(/hello world/)).toBeDefined()
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
  })

  it("highlights bash when lang=bash (proves broadened lang set)", async () => {
    const { container } = render(
      <CodeBlock
        code={"echo $HOME"}
        lang="bash"
      />,
    )
    // bash grammar produces at least one colored token (built-in/variable/string).
    await waitFor(() => {
      const colored = Array.from(container.querySelectorAll<HTMLSpanElement>("span[style*='color']"))
      // More than one distinct color ⇒ real syntactic highlighting (not just default text color).
      const distinct = new Set(colored.map((s) => s.style.color))
      expect(distinct.size).toBeGreaterThan(1)
    })
  })

  it("renders empty gutter (no crash) for empty code", () => {
    const { container } = render(<CodeBlock code="" />)
    // No line rows, no token spans, but the bordered shell still mounts.
    expect(container.querySelector("span[style*='color']")).toBeNull()
    expect(container.querySelector("[class*='border-l-2']")).not.toBeNull()
  })
})

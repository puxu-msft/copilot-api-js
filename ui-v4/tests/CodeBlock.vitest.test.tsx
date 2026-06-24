import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { CodeBlock } from "@/components/detail/CodeBlock"

describe("CodeBlock", () => {
  it("highlights JSON into hljs token spans with line numbers", () => {
    const { container } = render(<CodeBlock code={'{ "path": "a.ts" }'} />)

    // A property key → hljs-attr span; a string value → hljs-string span.
    const attr = container.querySelector(".hljs-attr")
    const str = container.querySelector(".hljs-string")
    expect(attr).not.toBeNull()
    expect(str).not.toBeNull()
    expect(attr?.textContent).toContain("path")
    expect(str?.textContent).toContain("a.ts")

    // Single source line → gutter line number 1 present.
    expect(screen.getByText("1")).toBeDefined()
  })

  it("renders a number token via hljs-number", () => {
    const { container } = render(<CodeBlock code={'{ "n": 42 }'} />)
    const num = container.querySelector(".hljs-number")
    expect(num).not.toBeNull()
    expect(num?.textContent).toContain("42")
  })

  it("renders literal token (true/false/null) via nested keyword leaf class", () => {
    // json grammar nests `true` as hljs-literal > hljs-keyword > text; flatten
    // keeps the innermost leaf class (hljs-keyword), both mapped to the same
    // accent in theme.css.
    const { container } = render(<CodeBlock code={'{ "ok": true }'} />)
    const lit = container.querySelector(".hljs-keyword")
    expect(lit).not.toBeNull()
    expect(lit?.textContent).toContain("true")
  })

  it("renders one gutter line number per source line for multi-line JSON", () => {
    const code = JSON.stringify({ alpha: "x", beta: "y" }, null, 2)
    // 4 lines: `{`, `  "alpha": "x",`, `  "beta": "y"`, `}` — string values avoid
    // colliding with the numeric gutter cells.
    expect(code.split("\n")).toHaveLength(4)
    render(<CodeBlock code={code} />)
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    expect(screen.getByText("3")).toBeDefined()
    expect(screen.getByText("4")).toBeDefined()
  })

  it("splits a multi-line string token across lines (class carried to each piece)", () => {
    // A TS template literal spanning two PHYSICAL lines is ONE hljs-string token
    // whose `.text` contains a real `\n` — this exercises splitIntoLines' i>0
    // multi-line cut (a JSON `\\n` escape would stay on one physical line and
    // never hit that branch).
    const code = "const x = `a\nb`"
    const { container } = render(
      <CodeBlock
        code={code}
        lang="typescript"
      />,
    )
    // Two physical lines → gutter rows 1 and 2.
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    // The single string token was cut across both lines → a hljs-string span on
    // each line (>1 span proves the multi-line split actually ran).
    const strings = container.querySelectorAll(".hljs-string")
    expect(strings.length).toBeGreaterThan(1)
    const combined = Array.from(strings)
      .map((n) => n.textContent)
      .join("")
    expect(combined).toContain("a")
    expect(combined).toContain("b")
  })

  it("falls back to plaintext for an unknown language without crashing", () => {
    render(
      <CodeBlock
        code={"hello world\nsecond line"}
        lang="not-a-real-lang"
      />,
    )
    // Raw text rendered (no hljs scopes), still line-numbered.
    expect(screen.getByText(/hello world/)).toBeDefined()
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
  })

  it("highlights bash when lang=bash", () => {
    const { container } = render(
      <CodeBlock
        code={"echo $HOME"}
        lang="bash"
      />,
    )
    // bash grammar produces at least one scoped token (built_in/variable/string).
    expect(container.querySelector("[class^='hljs-']")).not.toBeNull()
  })

  it("renders empty gutter (no crash) for empty code", () => {
    const { container } = render(<CodeBlock code="" />)
    // No line rows, no token spans, but the bordered shell still mounts.
    expect(container.querySelector(".hljs-string")).toBeNull()
    expect(container.querySelector("[class*='border-l-2']")).not.toBeNull()
  })
})

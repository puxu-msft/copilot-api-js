/**
 * Pure logic for the "JSON decode" tools page.
 *
 * Two small, dependency-free text transforms shared by the UI:
 * - {@link unescapeJsonString}: single-level unescape of an escaped JSON string
 *   (e.g. `tool_call` arguments copied out of a request, which arrive as a
 *   quoted-and-escaped string literal).
 * - {@link parseJson}: parse text into a value for the collapsible tree view.
 */

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Decode JSON string escape sequences exactly once (single-level).
 *
 * Accepts either a quoted JSON string literal (`"…"`) or a bare escaped body.
 * Decoding is delegated to `JSON.parse` so `\"`, `\\`, `\n`, `\t`, `\uXXXX`, …
 * all follow standard JSON semantics. Because it is a single pass, one layer of
 * escaping is peeled off: `{\"a\":1}` → `{"a":1}`, and a double-escaped body
 * yields a still-escaped body.
 *
 * Already-clean JSON (no escapes) has nothing to decode and surfaces the parse
 * error rather than silently returning the input.
 */
export function unescapeJsonString(input: string): ToolResult<string> {
  const trimmed = input.trim()
  if (trimmed === "") return { ok: false, error: "输入为空" }

  // A quoted literal parses as-is; a bare body is wrapped so `JSON.parse`
  // decodes the escape sequences inside the (now) quoted string.
  const literal = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed : `"${trimmed}"`

  try {
    const decoded = JSON.parse(literal) as unknown
    if (typeof decoded !== "string") return { ok: false, error: "解码结果不是字符串" }
    return { ok: true, value: decoded }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "解码失败" }
  }
}

/** Parse text as JSON for the tree view. Whitespace-tolerant; empty is an error. */
export function parseJson(input: string): ToolResult<unknown> {
  const trimmed = input.trim()
  if (trimmed === "") return { ok: false, error: "输入为空" }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "解析失败" }
  }
}

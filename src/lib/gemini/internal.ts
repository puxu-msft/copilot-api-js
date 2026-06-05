/**
 * Internal helpers shared between Gemini conversion modules.
 * Not exported from `./index.ts` — call sites stay inside the directory.
 */

/**
 * Parse a tool_call `arguments` JSON string into an object.
 *
 * Tool args are sent as opaque JSON strings by OpenAI; Gemini expects a
 * structured `args` object on `functionCall`. We defensively parse and
 * fall back to `{}` for any malformed / non-object input so a single bad
 * upstream chunk cannot poison the whole response.
 */
export function safeParseArgs(args: string): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** Tool input_schema 顶层字段的 JSON Schema 类型（仅本模块关心的子集）。 */
export type ParamType = "string" | "number" | "integer" | "boolean" | "array" | "object"

/** 工具名 → 顶层参数名 → 类型。用于把降级文本里的字符串参数值按 schema 定型。 */
export type ToolParamTypes = Record<string, ParamType>

const KNOWN_TYPES = new Set<string>(["string", "number", "integer", "boolean", "array", "object"])

/** 从请求 tools 提取每个工具的顶层参数类型表。input_schema 是松类型 Record，逐层防御性收窄。 */
export function extractToolParamTypes(tools: ReadonlyArray<{ name: string; input_schema?: Record<string, unknown> }> | undefined): Map<string, ToolParamTypes> {
  const out = new Map<string, ToolParamTypes>()
  if (!tools) return out
  for (const tool of tools) {
    const props = (tool.input_schema?.properties ?? undefined) as Record<string, unknown> | undefined
    const types: ToolParamTypes = {}
    if (props && typeof props === "object") {
      for (const [key, raw] of Object.entries(props)) {
        const t = (raw as { type?: unknown } | null)?.type
        if (typeof t === "string" && KNOWN_TYPES.has(t)) types[key] = t as ParamType
      }
    }
    out.set(tool.name, types)
  }
  return out
}

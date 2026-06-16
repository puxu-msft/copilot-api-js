/** validateInvokeRegion 的结果：解析成功带 name + 顶层参数原始字符串值。 */
export type InvokeParseResult = { ok: true; name: string; params: Record<string, string> } | { ok: false }

const PARAM_OPEN = /<parameter name="([^"]+)">/g
const PARAM_CLOSE = "</parameter>"

/**
 * 校验并解析单个 `<invoke name="X">…</invoke>` 区间（含标签间任意空白）。
 *
 * 用 whitespace-tolerant 的位置不变量防「content 含 </parameter>/<parameter> 字面量
 * 导致的腰斩」——绝不产出「解析成功但内容残缺」的结果。不变量：
 *  1. 每个 <parameter name="K"> 非贪婪配其后第一个 </parameter>。
 *  2. 每个 </parameter> 之后第一个非空白 token 必为 <parameter 或 </invoke>（覆盖性）。
 *  3. region 内 <parameter 数 == </parameter> 数（无游离闭合）。
 */
export function validateInvokeRegion(region: string): InvokeParseResult {
  const m = region.match(/^<invoke name="([^"]+)">([\s\S]*)<\/invoke>\s*$/)
  if (!m) return { ok: false }
  const inner = m[2]
  const params: Record<string, string> = {}
  let pos = 0
  while (pos < inner.length) {
    const ws = /^\s*/.exec(inner.slice(pos))?.[0] ?? ""
    pos += ws.length
    if (pos >= inner.length) break
    PARAM_OPEN.lastIndex = pos
    const om = PARAM_OPEN.exec(inner)
    if (!om || om.index !== pos) return { ok: false }
    const valStart = pos + om[0].length
    const closeIdx = inner.indexOf(PARAM_CLOSE, valStart)
    if (closeIdx === -1) return { ok: false }
    params[om[1]] = inner.slice(valStart, closeIdx)
    pos = closeIdx + PARAM_CLOSE.length
  }
  const opens = (inner.match(/<parameter name="/g) ?? []).length
  const closes = (inner.match(/<\/parameter>/g) ?? []).length
  if (opens !== closes) return { ok: false }
  return { ok: true, name: m[1], params }
}

const RESIDUE_TOKENS = ["<function_calls>", "function_calls", "call"] as const

/**
 * 找降级 tool-call 区的切点（markPos），无则 -1。tier-agnostic（决定缓冲/切散文用，
 * 最终档 A/B 判定由门控谓词在 COMMIT 时做）。
 *
 * 规则：找第一个 `<invoke name="X">` 且 X∈toolNames；若其紧前（仅空白间隔）有降级残留
 * token（call/function_calls/<function_calls>），markPos = 残留 token 起点（使 `call`
 * 不被转发）；否则 markPos = `<invoke` 起点。
 */
export function findDowngradeMarkPos(text: string, toolNames: ReadonlySet<string>): number {
  const re = /<invoke name="([^"]+)">/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!toolNames.has(m[1])) continue
    const invokePos = m.index
    const before = text.slice(0, invokePos)
    const wsLen = /\s*$/.exec(before)?.[0].length ?? 0
    const beforeWs = before.slice(0, before.length - wsLen)
    for (const token of RESIDUE_TOKENS) {
      if (beforeWs.endsWith(token)) {
        const tokenStart = beforeWs.length - token.length
        const charBefore = tokenStart > 0 ? beforeWs[tokenStart - 1] : ""
        if (charBefore === "" || /[\s。.,:;)】\]>]/.test(charBefore)) return tokenStart
      }
    }
    return invokePos
  }
  return -1
}

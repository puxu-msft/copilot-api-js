/**
 * ============================================================================
 * PoC：web_fetch server tool 的「execute 后端」——唯一相对 web_search 新增的部件
 * ============================================================================
 *
 * 这是一个概念验证（PoC）模块，**不是**生产代码，也不被服务器加载。
 *
 * 它证明什么：
 *   web_search 双跳（`src/lib/anthropic/web-search/orchestrator.ts`）的四步骨架
 *   （探针 → execute → 二跳 → 合成）里，只有第 2 步「execute」是每个 server tool
 *   各不相同的部件。对 web_search，execute 是「跑搜索后端」（`backends.ts`，含
 *   SearXNG/Responses 等，~15KB）。对 **web_fetch**，输入已是一个确定的 URL，
 *   execute 就退化成 **一次 fetch + 把 HTML 抽成可读正文** —— 连搜索后端都不用配。
 *
 *   → 这就是「双跳范式可推广到 web_search 之外」的最小、最干净样本：换掉 execute，
 *     其余（detect / downgrade-to-function-tool / 二跳 / synthesize）与 web_search 同构。
 *
 * 可独立运行（无需 Copilot 凭据、不消耗任何额度）：
 *   bun run exp/server-tool-web-fetch-poc/fetch-backend.ts https://example.com
 *   bun run exp/server-tool-web-fetch-poc/fetch-backend.ts            # 默认 example.com
 *
 * 依赖：零外部依赖，只用 Bun/Node 内置 fetch。HTML→text 用朴素剥离（去 script/style
 * /标签 + 折叠空白），足以证明 execute 的 triviality；生产化时可换 readability/
 * `@mozilla/readability` 等成熟库（battle-tested-over-hand-rolled），骨架不变。
 *
 * ⚠️ 两点生产化知会（PoC 本身不处理）：
 *   - SSRF 面：execute 会 fetch 一个**模型/客户端可控的任意 URL**（localhost/内网/云元数据端点
 *     均可达）——web_search 后端不抓任意 URL，web_fetch 会。生产 execute 应加目标校验（拒私网/元数据 IP）。
 *   - maxChars 截断发生在 `res.text()` 读完整个 body 进内存**之后**：对「防二跳 context 撑爆」有效，
 *     但对 proxy 自身内存无效（超大页仍全量入内存）。生产可改流式读 + 早停。
 */

// ============================================================================
// 结果类型（对齐 web-search/backends.ts:SearchExecutionResult 的形状取向）
// ============================================================================

/** web_fetch execute 的结果。ok=false 时 text 携带错误摘要（吸收进 *_tool_result_error 块）。 */
export interface FetchExecutionResult {
  ok: boolean
  /** 请求的 URL（规范化后）。 */
  url: string
  /** 抽取出的可读正文（ok=false 时是错误摘要）。 */
  text: string
  /** HTTP 状态码（网络层失败时 undefined）。 */
  status?: number
  /** 最终 URL（跟随重定向后）。 */
  finalUrl?: string
  /** 抽取前的原始字节大小（诊断用）。 */
  rawBytes?: number
  /** 上游/网络耗时（ms）。 */
  durationMs: number
}

// ============================================================================
// HTML → 可读正文（朴素实现，PoC 够用）
// ============================================================================

/** 去掉 <script>/<style>/<noscript> 整块（含内容），再去所有标签，解 HTML 实体，折叠空白。 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
  // 块级标签转换行，让抽出的文本保留基本段落结构。
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
  const stripped = withBreaks.replace(/<[^>]+>/g, " ")
  const decoded = decodeEntities(stripped)
  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

/** 解常见 HTML 实体（PoC 够用，非完整表）。 */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" }
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m)
}

/** 提取 <title>（诊断/合成时可用）。 */
export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() || undefined : undefined
}

// ============================================================================
// execute：一次 fetch + 抽正文
// ============================================================================

export interface ExecuteWebFetchArgs {
  url: string
  /** 抽取正文的最大字符数（防超大页把二跳 context 撑爆）。默认 100_000。 */
  maxChars?: number
  /** 下游客户端断连时中止本次 fetch。 */
  clientAbortSignal?: AbortSignal
  /** 请求超时（ms）。默认 20_000。 */
  timeoutMs?: number
}

/**
 * 执行一次 web_fetch：GET url，若是 HTML 则抽正文，否则原样返回文本。
 * 永不抛——失败折进 { ok:false, text:<错误摘要> }，与 web-search 的 executeWebSearch
 * 一致（搜索失败也被吸收成 error 块，不 hard-fail 双跳）。
 */
export async function executeWebFetch(args: ExecuteWebFetchArgs): Promise<FetchExecutionResult> {
  const { url, maxChars = 100_000, clientAbortSignal, timeoutMs = 20_000 } = args
  const started = performance.now()

  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(new Error(`web_fetch timeout after ${timeoutMs}ms`)), timeoutMs)
  // 组合下游断连信号 + 本地超时。
  const signal = clientAbortSignal ? AbortSignal.any([clientAbortSignal, timeoutCtl.signal]) : timeoutCtl.signal

  try {
    const res = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        // 用常见 UA，避免部分站点对空 UA 返回 403。
        "user-agent": "Mozilla/5.0 (compatible; copilot-api-web-fetch-poc/0.1)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    })
    const contentType = res.headers.get("content-type") ?? ""
    const raw = await res.text()
    const durationMs = Math.round(performance.now() - started)

    if (!res.ok) {
      return { ok: false, url, text: `HTTP ${res.status} fetching ${url}: ${raw.slice(0, 500)}`, status: res.status, finalUrl: res.url, rawBytes: raw.length, durationMs }
    }

    const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw)
    const body = isHtml ? htmlToText(raw) : raw
    const title = isHtml ? extractTitle(raw) : undefined
    const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n…[truncated ${body.length - maxChars} chars]` : body
    const text = title ? `# ${title}\n\n${clipped}` : clipped

    return { ok: true, url, text, status: res.status, finalUrl: res.url, rawBytes: raw.length, durationMs }
  } catch (error) {
    const durationMs = Math.round(performance.now() - started)
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, url, text: `web_fetch failed for ${url}: ${message}`, durationMs }
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// CLI demo（独立可跑，无凭据/无额度）
// ============================================================================

if (import.meta.main) {
  const target = process.argv[2] ?? "https://example.com"
  console.log(`[web-fetch-poc] fetching: ${target}\n`)
  const result = await executeWebFetch({ url: target })
  console.log("ok        =", result.ok)
  console.log("status    =", result.status)
  console.log("finalUrl  =", result.finalUrl)
  console.log("rawBytes  =", result.rawBytes)
  console.log("durationMs=", result.durationMs)
  console.log("\n----- extracted text (first 1500 chars) -----\n")
  console.log(result.text.slice(0, 1500))
  process.exit(result.ok ? 0 : 1)
}

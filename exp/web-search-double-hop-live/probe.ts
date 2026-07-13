/**
 * ============================================================================
 * Live 探针：web_search 双跳端到端实测（gpt-5.5 作搜索后端）
 * ============================================================================
 *
 * 这是一个概念验证（PoC）脚本，**不是**生产代码，也不被服务器加载。
 *
 * ⚠️ 运行须知（务必先读）：
 *   - 本脚本会**发多次真实上游请求**：双跳的 hop1（主模型决定是否搜索）+ 一次
 *     Copilot `/responses` 搜索（gpt-5.5 + web_search_preview）+ hop2（主模型生成答案），
 *     共约 3 次真实上游交互，消耗真实 Copilot 额度。
 *   - 需要**真实的 Copilot 凭据**：走本项目 token 逻辑（`initTokenManagers`），同 `bun run start`。
 *   - `no-auto-server` 语境下 AI agent 默认不替你跑；本探针可由用户手动执行：
 *       bun run exp/web-search-double-hop-live/probe.ts
 *
 * 它在测什么、为什么关键：
 *   web_search 双跳（`src/lib/anthropic/web-search/orchestrator.ts`）此前只有 **mock 上游**的
 *   集成测试（`tests/anthropic/web-search/`，48 pass）——`docs/spec/request-lineage-v2.md:189`
 *   实测确认「当前无真实 web_search 流量」，即该范式**从未真实端到端跑通过**。本探针补这个
 *   live 缺口：用 **gpt-5.5 作搜索后端**（config `server_tool_web_search.backend: gpt-5.5`，
 *   走 Copilot `/responses` 的 `web_search_preview`，免起本地 SearXNG），真跑一次完整双跳，
 *   验证 mock 测不到的真实行为：
 *     - hop1 的真实主模型**是否真的**发起 web_search tool_use（而非直接作答）。
 *     - gpt-5.5 搜索后端**是否真返回**可解析的结果（title/url）。
 *     - hop2 + 合成**是否产出**规范的 `server_tool_use{web_search} → web_search_tool_result → text` 序列。
 *
 * 复用生产逻辑（不臆造）：
 *   直接调生产入口 `orchestrateWebSearch()`（`web-search-handler` 在 search 分支调的正是它），
 *   传 `backend: "gpt-5.5"`。两个主模型 hop 经 `runAnthropicPipeline`（真实 GHC Anthropic 端点），
 *   搜索经 `executeWebSearch` → `createResponses`（真实 Copilot `/responses`）。
 *
 * 背景权威：skill `ghc-api-reference`；姊妹探针 `exp/server-tool-memory-probe/`、
 * `exp/server-tool-web-fetch-poc/`。
 */

import type { Model } from "~/lib/models/client"
import type { MessagesPayload, Tool } from "~/types/api/anthropic"

import { applyConfigToState } from "~/lib/config/config"
import { cacheVSCodeVersion, copilotBaseUrl } from "~/lib/copilot-api"
import { orchestrateWebSearch } from "~/lib/anthropic/web-search"
import { cacheModels } from "~/lib/models/client"
import { resolveModelName } from "~/lib/models/resolver"
import { setCliState, state } from "~/lib/state"
import { initTokenManagers } from "~/lib/token"

// ----------------------------------------------------------------------------
// 可调参数（环境变量覆盖）
// ----------------------------------------------------------------------------

/** 双跳的**主模型**（Anthropic 路径，通常 Claude）。gpt-5.5 是搜索后端、不是主模型。 */
const PROBE_MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-4.5"
/** 搜索后端：Copilot Responses 搜索模型 id。默认 gpt-5.5（本探针的核心）。 */
const PROBE_BACKEND = process.env.PROBE_BACKEND ?? "gpt-5.5"
const PROBE_ACCOUNT_TYPE = process.env.PROBE_ACCOUNT_TYPE
const PROBE_MAX_TOKENS = process.env.PROBE_MAX_TOKENS ? Number(process.env.PROBE_MAX_TOKENS) : 1024
/** 一个**必须联网搜索**才能答的 prompt，诱导 hop1 发起 web_search。 */
const PROBE_PROMPT =
  process.env.PROBE_PROMPT ??
  "Use the web_search tool to find the official Bun runtime website, then give me its URL. You must search; do not answer from memory."

const VALID_ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const
type AccountType = (typeof VALID_ACCOUNT_TYPES)[number]
function isValidAccountType(v: string | undefined): v is AccountType {
  return v !== undefined && (VALID_ACCOUNT_TYPES as ReadonlyArray<string>).includes(v)
}

function hr(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`)
}

// ----------------------------------------------------------------------------
// Bootstrap（复用生产启动逻辑，与 memory/web-fetch 探针一致）
// ----------------------------------------------------------------------------

async function bootstrap(): Promise<{ resolvedName: string; resolvedModel: Model }> {
  hr("Phase 1 · Bootstrap（复用生产启动逻辑）")

  await applyConfigToState()
  console.log("[bootstrap] config applied")

  if (PROBE_ACCOUNT_TYPE !== undefined) {
    if (!isValidAccountType(PROBE_ACCOUNT_TYPE)) {
      throw new Error(`Invalid PROBE_ACCOUNT_TYPE="${PROBE_ACCOUNT_TYPE}"; expected one of ${VALID_ACCOUNT_TYPES.join(", ")}`)
    }
    setCliState({ accountType: PROBE_ACCOUNT_TYPE })
    console.log(`[bootstrap] account-type overridden → ${PROBE_ACCOUNT_TYPE}`)
  }

  await cacheVSCodeVersion()
  console.log(`[bootstrap] vscode version = ${state.vsCodeVersion}`)

  await initTokenManagers({})
  if (!state.copilotToken) throw new Error("Copilot token not acquired — check credentials (run `copilot-api auth` first)")
  console.log("[bootstrap] copilot token acquired")

  await cacheModels()
  console.log(`[bootstrap] models cached (${state.modelIndex.size} entries)`)
  console.log(`[bootstrap] upstream base URL = ${copilotBaseUrl(state)}`)

  hr("Phase 2 · 解析主模型 + 校验搜索后端模型存在")
  const resolvedName = resolveModelName(PROBE_MODEL)
  const resolvedModel = state.modelIndex.get(resolvedName)
  console.log(`[probe] main model "${PROBE_MODEL}" → resolved "${resolvedName}"`)
  if (!resolvedModel) throw new Error(`Main model "${resolvedName}" not found in upstream model index (用 PROBE_MODEL=<id> 指定)。`)

  const backendResolved = resolveModelName(PROBE_BACKEND)
  const backendModel = state.modelIndex.get(backendResolved)
  console.log(`[probe] search backend "${PROBE_BACKEND}" → resolved "${backendResolved}" (found: ${Boolean(backendModel)})`)
  if (!backendModel) {
    console.warn(`[probe] ⚠️ 搜索后端模型 "${backendResolved}" 不在模型索引里——/responses 调用可能 404。用 PROBE_BACKEND=<id> 指定一个可用的 Responses 搜索模型。`)
  }

  return { resolvedName, resolvedModel }
}

// ----------------------------------------------------------------------------
// 校验合成响应的规范序列
// ----------------------------------------------------------------------------

interface ShapeCheck {
  blockTypes: Array<string>
  hasServerToolUse: boolean
  hasWebSearchResult: boolean
  hasText: boolean
  resultItemCount: number
  ok: boolean
}

function checkSynthesizedShape(response: unknown): ShapeCheck {
  const check: ShapeCheck = { blockTypes: [], hasServerToolUse: false, hasWebSearchResult: false, hasText: false, resultItemCount: 0, ok: false }
  if (typeof response !== "object" || response === null) return check
  const content = (response as Record<string, unknown>).content
  if (!Array.isArray(content)) return check
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue
    const b = block as Record<string, unknown>
    const t = typeof b.type === "string" ? b.type : ""
    check.blockTypes.push(t)
    if (t === "server_tool_use" && b.name === "web_search") check.hasServerToolUse = true
    if (t === "web_search_tool_result") {
      check.hasWebSearchResult = true
      const c = b.content
      if (Array.isArray(c)) check.resultItemCount = c.length
    }
    if (t === "text" && typeof b.text === "string" && b.text.trim()) check.hasText = true
  }
  check.ok = check.hasServerToolUse && check.hasWebSearchResult && check.hasText
  return check
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const { resolvedName, resolvedModel } = await bootstrap()

  hr("Phase 3 · 构造带原生 web_search server tool 的请求")
  const webSearchTool = { type: "web_search_20250305", name: "web_search", max_uses: 5 } as unknown as Tool
  const payload: MessagesPayload = {
    model: resolvedName,
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    tools: [webSearchTool],
  }
  console.log(`[probe] main model = ${resolvedName}, search backend = ${PROBE_BACKEND}`)
  console.log(`[probe] prompt = ${PROBE_PROMPT}`)

  hr("Phase 4 · 真跑双跳（hop1 → gpt-5.5 搜索 → hop2 → 合成）")
  try {
    const result = await orchestrateWebSearch({
      payload,
      resolvedModel,
      backend: PROBE_BACKEND,
    })

    console.log(`[probe] searched = ${result.searched}`)
    if (result.droppedSearchCount) console.log(`[probe] droppedSearchCount = ${result.droppedSearchCount}`)

    if (!result.searched) {
      hr("结果：hop1 未发起搜索 —— 主模型直接作答（未走完双跳）")
      console.log("[verdict] ⚠️ 未验证到双跳：hop1 主模型没调 web_search（直接答了）。")
      console.log("[verdict]    换一个更强制搜索的 PROBE_PROMPT（如问一条只有最新联网才知道的事实）重试。")
      console.log("[verdict]    响应块类型 =", JSON.stringify(checkSynthesizedShape(result.response).blockTypes))
      process.exit(2)
    }

    // ── 搜索子请求结果 ──
    if (result.search) {
      hr("搜索子请求（gpt-5.5 backend）结果")
      console.log(`[search] ok = ${result.search.ok}, model = ${result.search.model}, query = "${result.search.query}"`)
      console.log(`[search] results = ${result.search.results.length}, inputTokens = ${result.search.inputTokens}, outputTokens = ${result.search.outputTokens}`)
      for (const [i, r] of result.search.results.slice(0, 5).entries()) {
        console.log(`  ${i + 1}. ${r.title} — ${r.url}`)
      }
    }

    // ── 合成响应形状校验 ──
    const shape = checkSynthesizedShape(result.response)
    hr("合成响应形状校验")
    console.log(`[shape] 块类型序列 = ${JSON.stringify(shape.blockTypes)}`)
    console.log(`[shape] server_tool_use{web_search} = ${shape.hasServerToolUse}`)
    console.log(`[shape] web_search_tool_result（含 ${shape.resultItemCount} 项） = ${shape.hasWebSearchResult}`)
    console.log(`[shape] text 非空 = ${shape.hasText}`)

    hr("完整合成响应（截断 4000 字符）")
    console.log(JSON.stringify(result.response, null, 2).slice(0, 4000))

    hr("判据")
    if (shape.ok && result.search?.ok && result.search.results.length > 0) {
      console.log("[verdict] ✅ web_search 双跳端到端 · 真实跑通（gpt-5.5 搜索后端）")
      console.log("[verdict]    hop1 发起搜索 → gpt-5.5 返真实结果 → hop2+合成产出规范 server_tool_use→web_search_tool_result→text 序列。")
      process.exit(0)
    } else if (shape.ok) {
      console.log("[verdict] ⚠️ 双跳走完、结构规范，但搜索结果为空/失败（gpt-5.5 后端未返可解析结果）。")
      console.log(`[verdict]    search.ok=${result.search?.ok} results=${result.search?.results.length} —— 结构证明通，但内容层需换 prompt/后端复验。`)
      process.exit(3)
    } else {
      console.log("[verdict] ❌ 合成响应形状不完整（缺 server_tool_use / web_search_tool_result / text 之一）。")
      console.log("[verdict]    逐字读上面完整响应定位缺哪块。")
      process.exit(1)
    }
  } catch (error) {
    hr("结果：双跳抛错（hop 硬失败 / 网络 / 代码）")
    console.error(error)
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}

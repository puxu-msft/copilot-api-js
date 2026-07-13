/**
 * ============================================================================
 * PoC 探针：GHC / CAPI 路径对原生 `web_fetch_20250910` server tool 的接受性实测
 * ============================================================================
 *
 * 这是一个概念验证（PoC）脚本，**不是**生产代码，也不被服务器加载。
 *
 * ⚠️ 运行须知（务必先读）：
 *   - 本脚本会**发一次真实的上游请求**到 GitHub Copilot 的 CAPI
 *     （`https://api.githubcopilot.com/v1/messages` 或按 account-type 派生的域名）。
 *   - 需要**真实的 Copilot 凭据**：脚本走本项目自己的 token 逻辑（`initTokenManagers`），
 *     与 `bun run start` 完全一致。没有有效凭据会在 token 阶段失败。
 *   - 在项目的 `no-auto-server` 语境下，AI agent 不会替你跑本脚本——**由用户手动执行**：
 *       bun run exp/server-tool-web-fetch-poc/probe.ts
 *   - 只发一个 max_tokens 很小的最小请求，成本极低，但确实消耗一次真实 Copilot 交互额度。
 *
 * 它在测什么、为什么关键：
 *   web_fetch 若要「被 proxy 实现」，有两条互斥路线，本探针决定走哪条：
 *     (A) **上游原生就接受** `web_fetch_20250910` server tool 声明并自己执行抓取 →
 *         那 proxy **不用**自建 fetch 后端。但注意：原生执行产出的 `server_tool_use{web_fetch}` +
 *         `web_fetch_tool_result` 块，在生产响应路径会被**常驻 `server-tool-filter`（无条件）**吞掉，
 *         客户端看不到——所以 (A) 仍需 proxy **绕过响应过滤器 + 走专用 handler**（同 web_search-handler），
 *         **不是**「像 memory 一样零工作透传」（memory 产的是普通 `tool_use`，天然过得了过滤器）。
 *     (B) 上游 **400 拒绝**该声明 → proxy 必须像 web_search 那样**自建双跳**：探针把
 *         web_fetch 降级成普通函数工具、自己 fetch、二跳合成 web_fetch_tool_result。
 *
 * ⚠️ 探针观测 ≠ 生产客户端可见：本探针用 `createAnthropicMessages`，其非流式分支直接返回**原始上游
 *    JSON**（`client.ts:175`，不过响应过滤器），所以能看到 web_fetch 块；但同一响应在生产 v4/codec
 *    路径会被过滤器剥掉。探针证明的是「上游接不接受/执不执行」，**不**证明「客户端能不能看到」。
 *
 *   这正是 `server_tool_strip` / `server_tool_rewrite` 现在「一律 strip / 事后 downgrade」
 *   的替代问题：strip 是「假装它不存在」；本探针问的是「能不能让它真的存在」。
 *
 * wire 事实（复用生产逻辑，不臆造）：
 *   - 原生 web_fetch 工具形状（Anthropic 官方）：
 *       { "type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 5 }
 *   - 默认 config `anthropic.server_tool_strip: false` 且该 (endpoint,model) 未学习过
 *     web_fetch 拒绝时，`stripServerTools`（message-tools.ts）**原样转发** server tool
 *     声明到 wire（已核实：`web_fetch_` 在 SERVER_TOOL_TYPE_PREFIXES 内，但 default 不 strip）。
 *   - 探针经 `onPrepared` 抓下最终 wire.tools，**证明**声明确实到达上游（而非被预剥）。
 *     若 wire 里 web_fetch 消失，说明该 (endpoint,model) 已学习过拒绝 → 结论直接是 (B)。
 *
 * 背景权威：skill `ghc-api-reference`；姊妹探针 `exp/server-tool-memory-probe/`。
 */

import type { PreparedAnthropicRequest } from "~/lib/anthropic/client"
import type { Model } from "~/lib/models/client"
import type { MessagesPayload, Tool } from "~/types/api/anthropic"

import { createAnthropicMessages } from "~/lib/anthropic/client"
import { applyConfigToState } from "~/lib/config/config"
import { cacheVSCodeVersion, copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { getUnsupportedServerToolTypes } from "~/lib/anthropic/feature-negotiation"
import { cacheModels } from "~/lib/models/client"
import { resolveModelName } from "~/lib/models/resolver"
import { setCliState, state } from "~/lib/state"
import { initTokenManagers } from "~/lib/token"

// ----------------------------------------------------------------------------
// 可调参数（环境变量覆盖）
// ----------------------------------------------------------------------------

const PROBE_MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-4.5"
const PROBE_ACCOUNT_TYPE = process.env.PROBE_ACCOUNT_TYPE
/** 一个会诱导模型去抓取的 URL；默认给一个稳定的公开页。 */
const PROBE_URL = process.env.PROBE_URL ?? "https://example.com"
const PROBE_PROMPT =
  process.env.PROBE_PROMPT ?? `Fetch the page at ${PROBE_URL} and tell me its title. Use the web_fetch tool.`
const PROBE_MAX_TOKENS = process.env.PROBE_MAX_TOKENS ? Number(process.env.PROBE_MAX_TOKENS) : 512

/** 原生 web_fetch server tool 类型（Anthropic 官方 dated 变体）。 */
const WEB_FETCH_TYPE = process.env.PROBE_WEB_FETCH_TYPE ?? "web_fetch_20250910"

const VALID_ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const
type AccountType = (typeof VALID_ACCOUNT_TYPES)[number]
function isValidAccountType(v: string | undefined): v is AccountType {
  return v !== undefined && (VALID_ACCOUNT_TYPES as ReadonlyArray<string>).includes(v)
}

function hr(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`)
}

function getBetaHeader(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "anthropic-beta") return v
  }
  return undefined
}

// ----------------------------------------------------------------------------
// 端到端扫描：上游是否自己执行了 web_fetch？
// ----------------------------------------------------------------------------

interface E2eScan {
  contentBlockTypes: Array<string>
  webFetchServerToolUse: Array<unknown>
  webFetchToolResult: Array<unknown>
  /** 上游原生驱动/执行了 web_fetch（出现 server_tool_use{web_fetch} 或 web_fetch_tool_result）。 */
  nativelyHandled: boolean
}

function scanE2e(response: unknown): E2eScan {
  const scan: E2eScan = { contentBlockTypes: [], webFetchServerToolUse: [], webFetchToolResult: [], nativelyHandled: false }
  if (typeof response !== "object" || response === null) return scan
  const content = (response as Record<string, unknown>).content
  if (!Array.isArray(content)) return scan
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue
    const b = block as Record<string, unknown>
    const t = typeof b.type === "string" ? b.type : ""
    scan.contentBlockTypes.push(t)
    const name = typeof b.name === "string" ? b.name.toLowerCase() : ""
    if (t === "server_tool_use" && name.includes("web_fetch")) scan.webFetchServerToolUse.push(block)
    if (t === "web_fetch_tool_result" || (t.endsWith("_tool_result") && t.includes("web_fetch"))) scan.webFetchToolResult.push(block)
  }
  scan.nativelyHandled = scan.webFetchServerToolUse.length > 0 || scan.webFetchToolResult.length > 0
  return scan
}

// ----------------------------------------------------------------------------
// Bootstrap（复用生产启动逻辑，与 memory 探针一致）
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

  hr("Phase 2 · 解析模型")
  const resolvedName = resolveModelName(PROBE_MODEL)
  const resolvedModel = state.modelIndex.get(resolvedName)
  console.log(`[probe] client model "${PROBE_MODEL}" → resolved "${resolvedName}"`)
  if (!resolvedModel) throw new Error(`Model "${resolvedName}" not found in upstream model index (用 PROBE_MODEL=<id> 指定)。`)
  console.log(`[probe] resolved model vendor = ${resolvedModel.vendor}`)

  // 若该 (endpoint,model) 已学习过 web_fetch 拒绝，生产管线会预剥 → 提前告知，结论即 (B)。
  const learned = getUnsupportedServerToolTypes(resolvedName)
  if (learned.some((p) => p.startsWith("web_fetch"))) {
    console.warn(`[probe] ⚠️ 该模型已学习过 web_fetch 拒绝（${JSON.stringify(learned)}）——生产管线会预剥声明，wire 里将无 web_fetch。`)
    console.warn("[probe]    这本身就是结论 (B)：上游此前 400 拒绝过 web_fetch。若要重测纯接受性，清学习缓存后再跑。")
  }

  return { resolvedName, resolvedModel }
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const { resolvedName, resolvedModel } = await bootstrap()

  hr("Phase 3 · 构造带原生 web_fetch server tool 的最小请求")
  const webFetchTool = { type: WEB_FETCH_TYPE, name: "web_fetch", max_uses: 5 } as unknown as Tool
  const payload: MessagesPayload = {
    model: resolvedName,
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    tools: [webFetchTool],
  }
  console.log("[probe] inbound payload.tools =", JSON.stringify(payload.tools))

  hr("Phase 4 · 发送真实上游请求")
  let prepared: PreparedAnthropicRequest | undefined

  const dumpWire = () => {
    if (!prepared) return
    hr("实际发出的 wire（生产 prepare 管线产出）")
    console.log("wire.tools     =", JSON.stringify(prepared.wire.tools))
    console.log("anthropic-beta =", getBetaHeader(prepared.headers))
    const survived = JSON.stringify(prepared.wire.tools ?? []).includes("web_fetch")
    console.log(`[wire] web_fetch 声明是否到达上游 = ${survived}${survived ? "" : "（被预剥——结论直接是 (B)）"}`)
  }

  try {
    const response = await createAnthropicMessages(payload, {
      resolvedModel,
      onPrepared: (p) => {
        prepared = p
      },
    })
    dumpWire()

    hr("结果：上游 HTTP 2xx —— 未硬拒绝该 wire 形状")
    const body = typeof response === "object" ? JSON.stringify(response, null, 2) : String(response)
    console.log(body.slice(0, 4000))

    const scan = scanE2e(response)
    hr("判据：上游是否原生执行了 web_fetch")
    console.log(`[e2e] content[] 块类型序列 = ${JSON.stringify(scan.contentBlockTypes)}`)
    console.log(`[e2e] server_tool_use{web_fetch} 块数 = ${scan.webFetchServerToolUse.length}`)
    console.log(`[e2e] web_fetch_tool_result 块数 = ${scan.webFetchToolResult.length}`)
    if (scan.nativelyHandled) {
      console.log("\n[verdict] ✅ 路线 (A)：上游 CAPI 原生接受并执行 web_fetch —— proxy 无需自建 fetch 后端。")
      console.log("[verdict]    但生产上这些 server_tool_use / web_fetch_tool_result 块会被常驻 server-tool-filter 无条件吞掉，")
      console.log("[verdict]    客户端看不到；仍需绕过过滤器 + 专用 handler（同 web_search-handler），非零工作透传。")
      console.log("[verdict]    ⚠️ 本探针走 createAnthropicMessages（不过过滤器），故这里看得到 ≠ 生产客户端看得到。")
    } else {
      console.log("\n[verdict] ⚠️ 2xx 但未观测到 web_fetch 原生执行（无 server_tool_use / web_fetch_tool_result）。")
      console.log("[verdict]    可能：模型这次没调工具（换更强诱导的 PROBE_PROMPT / 更大 PROBE_MAX_TOKENS 重试），")
      console.log("[verdict]    或上游静默忽略了声明（既不 400 也不执行）——后者等价于路线 (B) 需自建双跳。")
    }
    process.exit(0)
  } catch (error) {
    dumpWire()
    if (error instanceof HTTPError) {
      hr(`结果：上游 HTTP ${error.status}`)
      console.log("[response body]", error.responseText)
      const low = error.responseText.toLowerCase()
      const mentionsWebFetch = low.includes("web_fetch") || low.includes("web fetch")
      const mentionsServerTool = low.includes("server") && low.includes("tool")
      const mentionsNotSupported = low.includes("not supported") || low.includes("not permitted") || low.includes("unknown") || low.includes("not defined")
      hr("判据")
      if (error.status === 400 && (mentionsWebFetch || (mentionsServerTool && mentionsNotSupported))) {
        console.log("[verdict] ✅ 路线 (B)：上游 400 拒绝 web_fetch server tool —— proxy 必须自建双跳（同 web_search）。")
        console.log(`[verdict] 命中信号：web_fetch=${mentionsWebFetch} serverTool=${mentionsServerTool} notSupported=${mentionsNotSupported}`)
      } else if (error.status === 400) {
        console.log("[verdict] 400 但响应体未直接点名 web_fetch/server-tool——逐字读上面 body 判根因（可能别的字段问题）。")
      } else {
        console.log(`[verdict] 非 400（HTTP ${error.status}）：多半与 web_fetch 无关（额度/鉴权/模型/网络），排除干扰后重跑。`)
      }
      if (error.diagnostics) console.log("[diagnostics]", JSON.stringify(error.diagnostics))
    } else {
      hr("结果：非 HTTP 错误（bootstrap / 网络 / 代码）")
      console.error(error)
    }
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}

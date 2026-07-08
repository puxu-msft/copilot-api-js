/**
 * ============================================================================
 * PoC 探针：CAPI 路径对 `memory_20250818` server tool + `context-management` beta
 *          的接受性实测
 * ============================================================================
 *
 * 这是一个概念验证（PoC）脚本，**不是**生产代码，也不被服务器加载。
 *
 * ⚠️ 运行须知（务必先读）：
 *   - 本脚本会**发一次真实的上游请求**到 GitHub Copilot 的非-BYOK CAPI
 *     （`https://api.githubcopilot.com/v1/messages` 或按 account-type 派生的域名）。
 *   - 需要**真实的 Copilot 凭据**：脚本走本项目自己的 token 获取逻辑
 *     （`initTokenManagers` → GitHub token → Copilot token），与 `bun run start`
 *     完全一致。没有有效凭据会在 token 阶段失败。
 *   - 在项目的 `no-auto-server` 语境下，AI agent 不会替你运行本脚本——
 *     **由用户手动执行**：`bun run exp/server-tool-memory-probe/probe.ts`。
 *   - 脚本只发一个 max_tokens=64 的最小请求（问模型说一句话），成本极低，
 *     但确实消耗一次真实的 Copilot 交互额度。
 *
 * 它在测什么、为什么：
 *   本项目经 CAPI（非 BYOK）暴露 Copilot。GHC 官方只在 **BYOK 直连** 时注入原生
 *   `memory_20250818` server tool；**CAPI 路径从不注入**，因此「经 CAPI 发这个
 *   server tool + `context-management-2025-06-27` beta，上游到底接不接受」从未
 *   被实测过——本项目的 `anthropic.server_tool_memory` 配置开关正因此默认关闭。
 *   本探针把那个开关**临时打开**，跑一次真实请求，从 HTTP 状态 + 响应体判定接受/拒绝。
 *
 * 它如何构造请求（复用生产逻辑，不臆造字段）：
 *   1. 完整 bootstrap 本项目状态（config → vscode 版本 → token → models），与
 *      `runServer` 的启动顺序一致。
 *   2. `setAnthropicBehavior({ memoryToolEnabled: true })` —— 这是探针的核心：
 *      把默认关闭的 memory 开关打开，正是我们要实测的那条路径。
 *   3. 构造一个最小 Anthropic Messages 请求，`tools` 里放一个 **plain 客户端工具
 *      `{ name: "memory" }`**（无 type）。这与真实客户端（如 Claude Code）发内存
 *      工具的形状一致。
 *   4. 调用生产入口 `createAnthropicMessages()`。它内部跑完整的 prepare 管线：
 *        - `rewrite-memory-tool` 步骤把 `{name:"memory"}` 改写成官方
 *          `{ name:"memory", type:"memory_20250818" }`（镜像 GHC BYOK anthropicProvider.ts）。
 *        - `build-headers` 步骤因 `ctx.hasMemoryTool` 强制加上共享的
 *          `context-management-2025-06-27` beta（GHC：`hasMemoryTool || contextManagement`）。
 *      →→ 因此 wire 形状与 header 都由**生产代码**产出，不是脚本手拼的。
 *   5. 通过 `onPrepared` 回调抓下最终的 wire body + headers，打印出来供人核对。
 *   6. 打印上游 HTTP status + 响应体，并给出「接受 / 被拒（附原因）」判据。
 *
 * 官方 wire 形状来源（权威）：
 *   - tool：`{ name:"memory", type:"memory_20250818" }` —— GHC `anthropic.ts`
 *     memory 原生 tool 常量 + BYOK `anthropicProvider.ts` 改写；本项目
 *     `src/lib/anthropic/request-preparation.ts:rewriteMemoryTool` 已镜像。
 *   - beta token：`context-management-2025-06-27` —— GHC `chatEndpoint.ts`
 *     getExtraHeaders（memory 与 context-editing 共用此 beta）；本项目
 *     `src/lib/anthropic/features.ts:buildAnthropicBetaHeaders` 已镜像。
 *   详见 skill `ghc-api-reference`。
 */

import type { PreparedAnthropicRequest } from "~/lib/anthropic/client"
import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createAnthropicMessages } from "~/lib/anthropic/client"
import { modelSupportsMemory } from "~/lib/anthropic/features"
import { applyConfigToState } from "~/lib/config/config"
import { cacheVSCodeVersion, copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { cacheModels } from "~/lib/models/client"
import { resolveModelName } from "~/lib/models/resolver"
import { setAnthropicBehavior, setCliState, state } from "~/lib/state"
import { initTokenManagers } from "~/lib/token"

// ----------------------------------------------------------------------------
// 可调参数（环境变量覆盖）
// ----------------------------------------------------------------------------

/** 目标模型（客户端别名，经 resolveModelName 归一）。默认取一个支持 memory 的 Claude。 */
const PROBE_MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-4.5"

/**
 * account-type，决定上游 base URL。默认 "individual"（api.githubcopilot.com）。
 * business / enterprise 账户须设 `PROBE_ACCOUNT_TYPE=business|enterprise`，否则
 * base URL 不对会在 cacheModels / 发请求阶段失败。
 */
const PROBE_ACCOUNT_TYPE = process.env.PROBE_ACCOUNT_TYPE

/**
 * user message 文本。默认逐字保持现状（"probe ok" 那句，不触发工具）。
 * 传 `PROBE_PROMPT=...` 覆盖成一个会诱导模型实际使用 memory 工具的 prompt，
 * 用于端到端验证 memory 是否真被调用（而非仅声明被接纳）。
 */
const PROBE_PROMPT = process.env.PROBE_PROMPT ?? "Reply with exactly the two words: probe ok. Do not use any tool."

/**
 * max_tokens。默认逐字保持现状 64（最小请求）。端到端触发 memory 调用时建议设
 * `PROBE_MAX_TOKENS=1024`，给模型足够 token 空间发工具调用块。
 */
const PROBE_MAX_TOKENS = process.env.PROBE_MAX_TOKENS ? Number(process.env.PROBE_MAX_TOKENS) : 64

const VALID_ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const
type AccountType = (typeof VALID_ACCOUNT_TYPES)[number]

function isValidAccountType(v: string | undefined): v is AccountType {
  return v !== undefined && (VALID_ACCOUNT_TYPES as ReadonlyArray<string>).includes(v)
}

// ----------------------------------------------------------------------------
// 打印助手
// ----------------------------------------------------------------------------

function hr(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`)
}

/** 从 headers 里取 anthropic-beta（大小写无关）。 */
function getBetaHeader(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "anthropic-beta") return v
  }
  return undefined
}

/**
 * 扫描 2xx 响应，判定 memory 工具是否**端到端被真正调用**。
 * 区分：
 *   - `content[]` 里出现 `type:"tool_use"` / `type:"server_tool_use"` 且 name/type 涉及 memory
 *     的块 → 模型真的发起了 memory 工具调用（端到端激活的强证据）。
 *   - `context_management.applied_edits` 非空 → 上游真的执行了 context-management 编辑。
 * 注意：模型在**文本里说**"我记住了"≠ 真调了工具（前者是敷衍幻觉，不算激活）。
 */
interface E2eScan {
  memoryToolBlocks: Array<unknown>
  appliedEdits: Array<unknown>
  contentBlockTypes: Array<string>
  activated: boolean
}

function scanE2e(response: unknown): E2eScan {
  const scan: E2eScan = { memoryToolBlocks: [], appliedEdits: [], contentBlockTypes: [], activated: false }
  if (typeof response !== "object" || response === null) return scan
  const obj = response as Record<string, unknown>

  // 1) content[] 里涉及 memory 的 tool_use / server_tool_use 块
  const content = obj.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue
      const b = block as Record<string, unknown>
      const t = typeof b.type === "string" ? b.type : ""
      scan.contentBlockTypes.push(t)
      const isToolUse = t === "tool_use" || t === "server_tool_use"
      const name = typeof b.name === "string" ? b.name.toLowerCase() : ""
      const rawType = t.toLowerCase()
      const mentionsMemory = name.includes("memory") || rawType.includes("memory")
      if (isToolUse && mentionsMemory) scan.memoryToolBlocks.push(block)
    }
  }

  // 2) context_management.applied_edits 非空
  const cm = obj.context_management
  if (typeof cm === "object" && cm !== null) {
    const edits = (cm as Record<string, unknown>).applied_edits
    if (Array.isArray(edits)) scan.appliedEdits = edits
  }

  scan.activated = scan.memoryToolBlocks.length > 0 || scan.appliedEdits.length > 0
  return scan
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  hr("Phase 1 · Bootstrap（复用生产启动逻辑）")

  // 1) config → state（含 memoryModels 等默认；与 runServer 的 applyConfigToState 一致）
  await applyConfigToState()
  console.log("[bootstrap] config applied")

  // account-type 覆盖（在 token / models 之前，因为它决定 base URL）
  if (PROBE_ACCOUNT_TYPE !== undefined) {
    if (!isValidAccountType(PROBE_ACCOUNT_TYPE)) {
      throw new Error(`Invalid PROBE_ACCOUNT_TYPE="${PROBE_ACCOUNT_TYPE}"; expected one of ${VALID_ACCOUNT_TYPES.join(", ")}`)
    }
    setCliState({ accountType: PROBE_ACCOUNT_TYPE })
    console.log(`[bootstrap] account-type overridden → ${PROBE_ACCOUNT_TYPE}`)
  }

  // 2) vscode 版本（editor-version header 用）
  await cacheVSCodeVersion()
  console.log(`[bootstrap] vscode version = ${state.vsCodeVersion}`)

  // 3) token（GitHub → Copilot；设置 state.copilotToken）
  await initTokenManagers({})
  if (!state.copilotToken) throw new Error("Copilot token not acquired — check credentials (run `copilot-api auth` first)")
  console.log("[bootstrap] copilot token acquired")

  // 4) models（填充 state.modelIndex，供模型解析 + resolvedModel 元数据）
  await cacheModels()
  console.log(`[bootstrap] models cached (${state.modelIndex.size} entries)`)
  console.log(`[bootstrap] upstream base URL = ${copilotBaseUrl(state)}`)

  hr("Phase 2 · 打开 memory 开关（探针核心，覆盖默认关闭）")
  setAnthropicBehavior({ memoryToolEnabled: true })
  console.log("[probe] state.memoryToolEnabled = true  (默认是 false)")

  hr("Phase 3 · 解析模型 + 前置校验")
  const resolvedName = resolveModelName(PROBE_MODEL)
  const resolvedModel: Model | undefined = state.modelIndex.get(resolvedName)
  console.log(`[probe] client model "${PROBE_MODEL}" → resolved "${resolvedName}"`)
  if (!resolvedModel) {
    throw new Error(`Model "${resolvedName}" not found in upstream model index. 可用模型见启动日志；用 PROBE_MODEL=<id> 指定。`)
  }
  console.log(`[probe] resolved model vendor = ${resolvedModel.vendor}`)

  const supportsMemory = modelSupportsMemory(resolvedName, resolvedModel)
  console.log(`[probe] modelSupportsMemory("${resolvedName}") = ${supportsMemory}`)
  if (!supportsMemory) {
    throw new Error(
      `Model "${resolvedName}" 不在 memoryModels 允许列表里，rewrite-memory-tool 不会触发。` +
        ` 换一个支持 memory 的 Claude（如 claude-sonnet-4.5 / claude-opus-4.5）：PROBE_MODEL=<id>。`,
    )
  }

  hr("Phase 4 · 构造最小请求（plain memory 客户端工具 → 生产管线改写）")
  const payload: MessagesPayload = {
    model: resolvedName,
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
    messages: [
      {
        role: "user",
        content: PROBE_PROMPT,
      },
    ],
    // Plain 客户端工具（无 type）。生产管线的 rewrite-memory-tool 步骤会把它改写成
    // 官方 { name:"memory", type:"memory_20250818" }，并触发 context-management beta。
    tools: [
      {
        name: "memory",
        description: "Memory tool (probe: will be rewritten to native memory_20250818 server tool).",
        input_schema: { type: "object", properties: {} },
      },
    ],
  }
  console.log("[probe] inbound payload.tools =", JSON.stringify(payload.tools))

  hr("Phase 5 · 发送真实上游请求")
  let prepared: PreparedAnthropicRequest | undefined

  try {
    const response = await createAnthropicMessages(payload, {
      resolvedModel,
      onPrepared: (p) => {
        prepared = p
      },
    })

    // ----- 打印实际 wire 形状（由生产 prepare 管线产出）-----
    if (prepared) {
      hr("实际发出的 wire（生产 prepare 管线产出）")
      console.log("wire.tools    =", JSON.stringify(prepared.wire.tools))
      console.log("anthropic-beta =", getBetaHeader(prepared.headers))
      console.log("all headers    =", JSON.stringify(prepared.headers, null, 2))
    }

    // 到这里 = 上游 2xx，没抛 HTTPError。
    hr("结果：上游 HTTP 2xx —— ✅ 接受")
    console.log("[verdict] ACCEPTED: 上游未拒绝 memory_20250818 server tool + context-management beta。")
    console.log("[verdict] 响应体（截断到 4000 字符）：")
    const body = typeof response === "object" ? JSON.stringify(response, null, 2) : String(response)
    console.log(body.slice(0, 4000))

    // ----- 端到端激活判据：扫描 content[] 的 memory tool_use 块 + applied_edits -----
    const scan = scanE2e(response)
    hr("端到端激活判据（memory 工具是否真被调用）")
    console.log(`[e2e] content[] 块类型序列 = ${JSON.stringify(scan.contentBlockTypes)}`)
    console.log(`[e2e] memory 相关 tool_use/server_tool_use 块数 = ${scan.memoryToolBlocks.length}`)
    if (scan.memoryToolBlocks.length > 0) {
      console.log(`[e2e] memory 工具块内容 = ${JSON.stringify(scan.memoryToolBlocks, null, 2)}`)
    }
    console.log(`[e2e] context_management.applied_edits 条数 = ${scan.appliedEdits.length}`)
    if (scan.appliedEdits.length > 0) {
      console.log(`[e2e] applied_edits 内容 = ${JSON.stringify(scan.appliedEdits, null, 2)}`)
    }
    if (scan.activated) {
      console.log("[e2e] >>> memory 工具被端到端调用：是 <<<（观测到 memory tool_use 块或非空 applied_edits）")
    } else {
      console.log("[e2e] >>> memory 工具被端到端调用：否 <<<（无 memory tool_use 块、applied_edits 恒空）")
      console.log("[e2e] 注意：模型若只在文本里说'我记住了'不算激活——那是敷衍幻觉，不是真的工具调用。")
    }
    console.log(
      "\n[note] 2xx 只证明上游没有硬拒绝该 wire 形状。端到端激活须看上面 [e2e] 段：" +
        "\n       出现 memory 相关 server_tool_use / tool_use 块 = 真被调用；恒空 = 接纳声明但未观测到激活。",
    )
    process.exit(0)
  } catch (error) {
    // 即使失败也打印我们试图发出的 wire（onPrepared 在 fetch 前已回调）。
    if (prepared) {
      hr("实际发出的 wire（生产 prepare 管线产出）")
      console.log("wire.tools    =", JSON.stringify(prepared.wire.tools))
      console.log("anthropic-beta =", getBetaHeader(prepared.headers))
      console.log("all headers    =", JSON.stringify(prepared.headers, null, 2))
    }

    if (error instanceof HTTPError) {
      hr(`结果：上游 HTTP ${error.status}`)
      console.log("[response body]")
      console.log(error.responseText)

      const bodyLower = error.responseText.toLowerCase()
      // 判据：400 且响应体点名 memory / memory_20250818 / context-management / unknown tool type
      //       / beta 不支持 = 明确拒绝该特性。其它 4xx/5xx 可能是无关问题（额度、鉴权、模型）。
      const mentionsMemory =
        bodyLower.includes("memory_20250818") || bodyLower.includes("memory") || bodyLower.includes("context-management") || bodyLower.includes("context_management")
      const mentionsToolType = bodyLower.includes("tool") && (bodyLower.includes("type") || bodyLower.includes("unknown") || bodyLower.includes("not supported") || bodyLower.includes("not permitted"))
      const mentionsBeta = bodyLower.includes("beta") || bodyLower.includes("anthropic-beta")

      hr("判据")
      if (error.status === 400 && (mentionsMemory || mentionsToolType || mentionsBeta)) {
        console.log("[verdict] REJECTED（拒绝）：上游 400 且响应体点名 memory / tool type / beta —— CAPI 不接受该特性。")
        console.log(`[verdict] 命中信号：memory=${mentionsMemory} toolType=${mentionsToolType} beta=${mentionsBeta}`)
      } else if (error.status === 400) {
        console.log("[verdict] 可能拒绝（需人工判读）：400 但响应体未直接点名 memory/tool-type/beta。")
        console.log("[verdict] 逐字读上面 response body 判断根因（可能是别的字段问题，而非 memory）。")
      } else {
        console.log(`[verdict] 非 400（HTTP ${error.status}）：多半与 memory 特性无关（额度/鉴权/模型/网络）。`)
        console.log("[verdict] 读 response body 排除干扰后重跑；确认凭据与 account-type 正确。")
      }
      if (error.diagnostics) {
        console.log("[diagnostics]", JSON.stringify(error.diagnostics))
      }
    } else {
      hr("结果：非 HTTP 错误（bootstrap / 网络 / 代码）")
      console.error(error)
    }
    process.exitCode = 1
  }
}

await main()
// 现状进程会残留 keepalive / token-refresh timer 不退出（被外层 timeout 杀）。
// 2xx 路径已在 Phase 5 内 process.exit(0)；此处兜底覆盖 error 路径，让复跑干净退出。
process.exit(process.exitCode ?? 0)

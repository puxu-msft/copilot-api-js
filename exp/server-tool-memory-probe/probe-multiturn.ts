/**
 * ============================================================================
 * PoC 探针（多轮）：含 memory `tool_use` / `tool_result` 的多轮会话，是否被本项目
 *                   v4 请求侧 prepare 管线**原样透传**（不剥离、不打乱 pairing）
 * ============================================================================
 *
 * 这是 `probe.ts`（单跳）的多轮续作，**不是**生产代码，也不被服务器加载。
 * 它复用 `probe.ts` 的 `bootstrap()`（config → token → models → 打开 memory 开关
 * → 解析 + 校验模型），只新增多轮构造 + 完整请求侧管线 + wire 透传核查。
 *
 * ⚠️ 运行须知（同 probe.ts）：
 *   - 会发**两次**真实上游请求（Hop1 诱导 memory tool_use；Hop2 续接会话）到
 *     GitHub Copilot 非-BYOK CAPI。需要真实 Copilot 凭据（走本项目 token 逻辑）。
 *   - 在 `no-auto-server` 语境下由**用户手动执行**：
 *       PROBE_ACCOUNT_TYPE=enterprise bun run exp/server-tool-memory-probe/probe-multiturn.ts
 *
 * 它测什么、为什么：
 *   真实用（Claude Code）memory 是**多轮 client-executed**流程：上游发 memory
 *   `tool_use`（如 `view /memories`）→ client 执行 → 回 `tool_result` → 上游续跑，
 *   多轮至 `end_turn`。单跳探针（probe.ts）只证了「上游接受 memory 声明 + 端到端
 *   发起第一跳 tool_use」，**没验**「当发给上游的会话里已含 memory 的 `tool_use`
 *   （assistant 轮）+ `tool_result`（user 轮）时，本项目请求侧 prepare 管线是否
 *   原样透传这对块」。这是翻默认 `server_tool_memory` 前唯一没验的残留点。
 *
 * 它如何忠实复刻生产请求侧管线（关键：不绕过 sanitizer）：
 *   生产路由 `handler-v4.ts` 的请求侧顺序是
 *     preprocessAnthropicMessages（dedup + strip-read-tags）
 *       → runAnthropicPayloadRewrites（tool-preprocess → tool-name-sanitize →
 *         sanitize-messages，含 processToolBlocks：**孤儿 tool_use/tool_result 会被剥离**）
 *       → createAnthropicMessages（内部 prepareAnthropicRequest：rewrite-memory-tool
 *         / thinking 处理 / cache-control / build-headers）→ 发上游。
 *   注意：`createAnthropicMessages` 内部**只跑 prepare（第 3 段），不跑 sanitizer**。
 *   sanitizer 在生产里更早、在路由层跑。因此单跳 probe.ts 直接调
 *   createAnthropicMessages **不经过 sanitizer**——要验 sanitizer 是否误伤 memory 多轮，
 *   必须像本探针这样把前两段也跑上。`sendThroughPipeline()` 即复刻这三段。
 *
 * 透传的直接证据：
 *   打印 Hop2 **实际发出的 wire.messages**，逐一核对 assistant 轮的 memory `tool_use`
 *   块与 user 轮的 `tool_result` 块**都还在、tool_use_id 配对未乱**（对照发送前构造的
 *   会话）。Hop2 上游 2xx + 续跑（`end_turn` 或再发一个 memory op）= 透传确认。
 */

import type { PreparedAnthropicRequest } from "~/lib/anthropic/client"
import type { Model } from "~/lib/models/client"
import type {
  //
  ContentBlockParam,
  MessageParam,
  MessagesPayload,
  Message as AnthropicResponse,
  Tool,
} from "~/types/api/anthropic"

import { createAnthropicMessages } from "~/lib/anthropic/client"
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import { HTTPError } from "~/lib/error"

import { bootstrap, getBetaHeader, hr } from "./probe"

// ----------------------------------------------------------------------------
// 可调参数（环境变量覆盖）
// ----------------------------------------------------------------------------

/** Hop1 诱导 memory tool_use 的 prompt。 */
const PROBE_MT_PROMPT = process.env.PROBE_MT_PROMPT ?? "Check your memory for any notes about me before answering. Use the memory tool to look."

/** max_tokens。多轮须给足空间发/续 tool_use，默认 1024。 */
const PROBE_MAX_TOKENS = process.env.PROBE_MAX_TOKENS ? Number(process.env.PROBE_MAX_TOKENS) : 1024

/**
 * 合成的 client 侧 `tool_result` 内容——模拟 client 执行 `view /memories` 的返回。
 * 默认 "No memory files found."（Anthropic memory 工具 view 空目录的典型回值）。
 * 传 `PROBE_TOOL_RESULT=...` 换成一小段笔记，验非空结果是否也透传。
 */
const PROBE_TOOL_RESULT = process.env.PROBE_TOOL_RESULT ?? "No memory files found. The /memories directory is empty."

/** 目标模型（同 probe.ts，经 bootstrap 内 resolveModelName 归一）。 */
const PROBE_MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-4.5"

// ----------------------------------------------------------------------------
// 复刻生产请求侧管线：preprocess → sanitize → createAnthropicMessages
// ----------------------------------------------------------------------------

interface PipelineSend {
  response: AnthropicResponse
  prepared: PreparedAnthropicRequest | undefined
}

/**
 * 把一个 Anthropic Messages payload 经**完整生产请求侧管线**发给上游，返回响应 +
 * 实际发出的 wire（经 onPrepared 抓取）。忠实复刻 handler-v4 的三段顺序（见文件头）。
 *
 * 不吞错误：上游非 2xx 时 createAnthropicMessages 抛 HTTPError，由调用方分类判读。
 */
async function sendThroughPipeline(payloadIn: MessagesPayload, resolvedModel: Model, label: string): Promise<PipelineSend> {
  // 深拷贝，避免跨 hop 复用同一对象时被管线的就地改写污染。
  const payload: MessagesPayload = structuredClone(payloadIn)

  // ① 路由预处理（一次性、幂等）：dedup + strip-read-tags。
  const pre = preprocessAnthropicMessages(payload.messages)
  payload.messages = pre.messages
  console.log(`[${label}] preprocess: strippedReadTags=${pre.strippedReadTagCount} dedupedToolCalls=${pre.dedupedToolCallCount}`)

  // ② S3 请求重写链：tool-preprocess → tool-name-sanitize → sanitize-messages
  //    （processToolBlocks 在此——孤儿 tool_use/tool_result 会被剥离）。
  const toolNameMapper = buildAnthropicToolNameMapper(payload.tools, resolvedModel.id, resolvedModel.vendor)
  const { payload: sanitized, sanitizeResult } = runAnthropicPayloadRewrites(payload, { toolNameMapper })
  const s = sanitizeResult.stats
  console.log(
    `[${label}] sanitize stats: orphanedToolUse=${s.orphanedToolUseCount} orphanedToolResult=${s.orphanedToolResultCount}`
      + ` fixedName=${s.fixedNameCount} totalBlocksRemoved=${s.totalBlocksRemoved} emptyThinkingRemoved=${s.emptyThinkingBlocksRemoved}`,
  )

  // ③ createAnthropicMessages（内部 prepareAnthropicRequest：rewrite-memory-tool /
  //    thinking / cache-control / build-headers）→ 发上游。抓 wire。
  let prepared: PreparedAnthropicRequest | undefined
  const response = (await createAnthropicMessages(sanitized, {
    resolvedModel,
    onPrepared: (p) => {
      prepared = p
    },
  })) as AnthropicResponse
  return { response, prepared }
}

// ----------------------------------------------------------------------------
// 核查助手：扫描 messages 里的 tool_use / tool_result 配对
// ----------------------------------------------------------------------------

interface ToolPairScan {
  /** assistant 轮 tool_use（含 server_tool_use）的 id → name。 */
  toolUseIdToName: Map<string, string>
  /** user 轮 tool_result 的 tool_use_id 集合。 */
  toolResultIds: Set<string>
  /** name 涉及 memory 的 tool_use 块（原样）。 */
  memoryToolUseBlocks: Array<{ id: string; name: string; input: unknown }>
  /** content block 类型序列（按 message 分组），用于人眼核对结构未被打乱。 */
  perMessageBlockTypes: Array<{ role: string; types: Array<string> }>
}

function scanToolPairs(messages: Array<MessageParam> | undefined): ToolPairScan {
  const scan: ToolPairScan = {
    toolUseIdToName: new Map(),
    toolResultIds: new Set(),
    memoryToolUseBlocks: [],
    perMessageBlockTypes: [],
  }
  if (!Array.isArray(messages)) return scan

  for (const msg of messages) {
    const types: Array<string> = []
    if (typeof msg.content === "string") {
      types.push("<string>")
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>
        const t = typeof b.type === "string" ? b.type : "<unknown>"
        types.push(t)
        if (t === "tool_use" || t === "server_tool_use") {
          const id = typeof b.id === "string" ? b.id : ""
          const name = typeof b.name === "string" ? b.name : ""
          if (id) scan.toolUseIdToName.set(id, name)
          if (name.toLowerCase().includes("memory") || t.toLowerCase().includes("memory")) {
            scan.memoryToolUseBlocks.push({ id, name, input: b.input })
          }
        }
        if (t === "tool_result") {
          const tid = typeof b.tool_use_id === "string" ? b.tool_use_id : ""
          if (tid) scan.toolResultIds.add(tid)
        }
      }
    }
    scan.perMessageBlockTypes.push({ role: msg.role, types })
  }
  return scan
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

/** memory 客户端工具（无 type）；生产管线的 rewrite-memory-tool 会改写成 memory_20250818。 */
const MEMORY_CLIENT_TOOL: Tool = {
  name: "memory",
  description: "Memory tool (probe: rewritten to native memory_20250818 server tool by the prepare pipeline).",
  input_schema: { type: "object", properties: {} },
}

async function main(): Promise<void> {
  const { resolvedName, resolvedModel } = await bootstrap()

  // ==========================================================================
  // Hop 1 · 诱导上游发出 memory tool_use
  // ==========================================================================
  hr("Hop 1 · 发 memory-诱导 prompt（经完整生产请求侧管线）")
  const hop1Payload: MessagesPayload = {
    model: resolvedName,
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
    messages: [{ role: "user", content: PROBE_MT_PROMPT }],
    tools: [MEMORY_CLIENT_TOOL],
  }
  console.log(`[hop1] prompt = ${JSON.stringify(PROBE_MT_PROMPT)}`)

  let hop1: PipelineSend
  try {
    hop1 = await sendThroughPipeline(hop1Payload, resolvedModel, "hop1")
  } catch (error) {
    hr("Hop 1 失败（无法拿到 memory tool_use，多轮验证无法进行）")
    if (error instanceof HTTPError) {
      console.log(`[hop1] 上游 HTTP ${error.status}`)
      console.log(error.responseText)
    } else {
      console.error(error)
    }
    process.exitCode = 1
    return
  }

  const hop1Content = Array.isArray(hop1.response.content) ? hop1.response.content : []
  const hop1Types = hop1Content.map((b) => (b as { type?: string }).type ?? "<unknown>")
  console.log(`[hop1] 上游 2xx · stop_reason=${hop1.response.stop_reason} · content 块类型 = ${JSON.stringify(hop1Types)}`)

  // 从 Hop1 响应里找 memory tool_use 块。
  const memoryBlock = hop1Content.find((b) => {
    const bb = b as { type?: string; name?: string }
    return bb.type === "tool_use" && typeof bb.name === "string" && bb.name.toLowerCase().includes("memory")
  }) as { id?: string; name?: string; input?: unknown } | undefined

  if (!memoryBlock || typeof memoryBlock.id !== "string") {
    hr("Hop 1 未产出 memory tool_use（多轮验证无法进行）")
    console.log(`[hop1] stop_reason=${hop1.response.stop_reason}；未在 content[] 找到 name 含 "memory" 的 tool_use 块。`)
    console.log(`[hop1] 完整 content = ${JSON.stringify(hop1Content, null, 2)}`)
    console.log("[hop1] 说明：模型这轮没调 memory（可能只回了文本）。换更强诱导的 PROBE_MT_PROMPT 重试。")
    process.exitCode = 1
    return
  }
  const memoryToolUseId = memoryBlock.id
  console.log(`[hop1] 抓到 memory tool_use：id=${memoryToolUseId} name=${memoryBlock.name} input=${JSON.stringify(memoryBlock.input)}`)

  // ==========================================================================
  // 合成 client 侧 tool_result + 构造 Hop2 续接会话
  // ==========================================================================
  hr("合成 client 侧 tool_result + 构造 Hop 2 续接会话")

  // assistant 轮：**verbatim** 转发 Hop1 上游返回的整个 content 数组（thinking + tool_use），
  // 这正是真实 client（Claude Code）的做法——保留 thinking 签名连续性。
  const assistantContent = hop1Content as unknown as Array<ContentBlockParam>

  // user 轮：含合成的 tool_result，tool_use_id 指向 Hop1 的 memory tool_use。
  const toolResultBlock = {
    type: "tool_result" as const,
    tool_use_id: memoryToolUseId,
    content: PROBE_TOOL_RESULT,
  }

  const hop2Messages: Array<MessageParam> = [
    { role: "user", content: PROBE_MT_PROMPT },
    { role: "assistant", content: assistantContent },
    { role: "user", content: [toolResultBlock as unknown as ContentBlockParam] },
  ]

  // 发送前快照：构造出的会话里 tool_use/tool_result 的配对（作为透传核对的对照 oracle）。
  const constructedScan = scanToolPairs(hop2Messages)
  console.log(`[hop2:constructed] 每 message 块类型 = ${JSON.stringify(constructedScan.perMessageBlockTypes)}`)
  console.log(`[hop2:constructed] assistant tool_use ids = ${JSON.stringify([...constructedScan.toolUseIdToName.entries()])}`)
  console.log(`[hop2:constructed] user tool_result ids = ${JSON.stringify([...constructedScan.toolResultIds])}`)
  console.log(`[hop2:constructed] memory tool_use 块 = ${JSON.stringify(constructedScan.memoryToolUseBlocks)}`)

  const hop2Payload: MessagesPayload = {
    model: resolvedName,
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
    messages: hop2Messages,
    // 同真实 client：每轮都带上 tools，故 rewrite-memory-tool 再次触发 + 强制 context beta。
    tools: [MEMORY_CLIENT_TOOL],
  }

  // ==========================================================================
  // Hop 2 · 经同一管线发续接会话，核查 wire 透传 + 上游续跑
  // ==========================================================================
  hr("Hop 2 · 发续接会话（经完整生产请求侧管线）")
  let hop2: PipelineSend | undefined
  let hop2Error: HTTPError | undefined
  try {
    hop2 = await sendThroughPipeline(hop2Payload, resolvedModel, "hop2")
  } catch (error) {
    if (error instanceof HTTPError) {
      hop2Error = error
    } else {
      hr("Hop 2 非 HTTP 错误（bootstrap / 网络 / 代码）")
      console.error(error)
      process.exitCode = 1
      return
    }
  }

  // ----- 核查实际发出的 Hop2 wire.messages（透传的直接证据）-----
  const prepared = hop2?.prepared
  if (!prepared) {
    hr("未捕获 Hop2 wire（onPrepared 未回调——异常早退）")
    if (hop2Error) {
      console.log(`[hop2] 上游 HTTP ${hop2Error.status}`)
      console.log(hop2Error.responseText)
    }
    process.exitCode = 1
    return
  }

  hr("Hop 2 实际发出的 wire（生产 prepare 管线产出）")
  const wireMessages = prepared.wire.messages as Array<MessageParam> | undefined
  console.log("wire.tools     =", JSON.stringify(prepared.wire.tools))
  console.log("anthropic-beta =", getBetaHeader(prepared.headers))
  const wireScan = scanToolPairs(wireMessages)
  console.log(`[hop2:wire] 每 message 块类型 = ${JSON.stringify(wireScan.perMessageBlockTypes)}`)
  console.log(`[hop2:wire] assistant tool_use ids = ${JSON.stringify([...wireScan.toolUseIdToName.entries()])}`)
  console.log(`[hop2:wire] user tool_result ids = ${JSON.stringify([...wireScan.toolResultIds])}`)
  console.log(`[hop2:wire] memory tool_use 块 = ${JSON.stringify(wireScan.memoryToolUseBlocks)}`)
  console.log(`[hop2:wire] 完整 wire.messages = ${JSON.stringify(wireMessages, null, 2)}`)

  // ----- 透传判据（对照 constructed 快照）-----
  hr("透传判据（Hop2 wire vs 发送前构造）")
  const toolUseKept = wireScan.toolUseIdToName.has(memoryToolUseId)
  const toolResultKept = wireScan.toolResultIds.has(memoryToolUseId)
  const pairingIntact = toolUseKept && toolResultKept
  const memoryToolStillDeclared = Array.isArray(prepared.wire.tools)
    && (prepared.wire.tools as Array<Record<string, unknown>>).some((t) => t.name === "memory" && t.type === "memory_20250818")
  console.log(`[verdict] memory tool_use（id=${memoryToolUseId}）在 wire.assistant 轮：${toolUseKept ? "在 ✅" : "被剥离 ❌"}`)
  console.log(`[verdict] 对应 tool_result（tool_use_id=${memoryToolUseId}）在 wire.user 轮：${toolResultKept ? "在 ✅" : "被剥离 ❌"}`)
  console.log(`[verdict] tool_use ↔ tool_result 配对完好：${pairingIntact ? "是 ✅" : "否 ❌"}`)
  console.log(`[verdict] memory 工具声明仍被改写为 memory_20250818：${memoryToolStillDeclared ? "是 ✅" : "否 ❌"}`)

  // ----- 上游续跑判据 -----
  if (hop2Error) {
    hr(`Hop 2 上游 HTTP ${hop2Error.status}（响应体逐字如下，供分类判读）`)
    console.log(hop2Error.responseText)
    const bodyLower = hop2Error.responseText.toLowerCase()
    const namesToolResult = bodyLower.includes("tool_result") || bodyLower.includes("tool_use_id") || bodyLower.includes("tool_use")
    const namesMemory = bodyLower.includes("memory")
    const namesThinking = bodyLower.includes("thinking") || bodyLower.includes("signature")
    hr("Hop 2 400 分类（区分 管线剥离/打乱 vs 探针构造问题 vs thinking 无关项）")
    if (!pairingIntact) {
      console.log("[verdict] >>> 管线 BUG：wire 里 tool_use/tool_result 配对已被破坏（见上「透传判据」）——这是翻默认的真阻塞。 <<<")
      console.log("[verdict] 需定位是哪个环节剥离/打乱（sanitize processToolBlocks 孤儿判定 / thinking 过滤连带删除 assistant 轮 / 等）。")
    } else if (namesThinking && !namesMemory) {
      console.log("[verdict] 配对完好但 400 点名 thinking/signature —— **thinking 相关**，与 memory 透传正交（另一条战线）。非 memory 管线 bug。")
    } else if (namesMemory || namesToolResult) {
      console.log("[verdict] 配对完好、wire 形状正确，但上游对**合成 tool_result 的内容本身**不满 —— 探针构造问题，非管线 bug。")
      console.log("[verdict] 换更真实的 PROBE_TOOL_RESULT（贴合 memory view 协议返回）重试。")
    } else {
      console.log("[verdict] 配对完好但 400 未点名 memory/tool_result/thinking —— 逐字读上面响应体定位根因（可能是别的字段）。")
    }
    process.exitCode = 1
    return
  }

  // 2xx 路径
  const resp = hop2 as PipelineSend
  const hop2Content = Array.isArray(resp.response.content) ? resp.response.content : []
  const hop2Types = hop2Content.map((b) => (b as { type?: string }).type ?? "<unknown>")
  const followedUp = resp.response.stop_reason === "end_turn" || hop2Types.some((t) => t === "tool_use" || t === "server_tool_use")
  hr("Hop 2 结果：上游 2xx")
  console.log(`[hop2] stop_reason=${resp.response.stop_reason} · content 块类型 = ${JSON.stringify(hop2Types)}`)
  console.log(`[hop2] 响应体（截断 2000 字符）：`)
  console.log(JSON.stringify(resp.response, null, 2).slice(0, 2000))

  hr("最终判读")
  if (pairingIntact && followedUp) {
    console.log("[verdict] >>> 多轮 memory 往返透传：确认 ✅ <<<")
    console.log("[verdict] 请求侧 prepare 管线（preprocess + sanitize + prepare）原样透传了 memory 的 tool_use（assistant 轮）")
    console.log("[verdict] 与 tool_result（user 轮），配对未乱；上游接受该续接会话并续跑。")
  } else if (pairingIntact) {
    console.log("[verdict] wire 透传完好、上游 2xx，但 stop_reason 既非 end_turn 也未再发工具——人工核对上面响应体。")
  } else {
    console.log("[verdict] >>> 管线剥离/打乱了 memory 块但上游竟 2xx（罕见）——见上「透传判据」，仍属需修复的管线偏差。 <<<")
  }
}

if (import.meta.main) {
  await main()
  // 同 probe.ts：残留 keepalive / token-refresh timer 不退出，显式退出让复跑干净。
  process.exit(process.exitCode ?? 0)
}

// 供潜在的进一步探针复用。
export { PROBE_MODEL, PROBE_MT_PROMPT }

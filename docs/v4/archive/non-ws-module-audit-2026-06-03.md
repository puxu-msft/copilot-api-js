# 非 WS 模块全面审查报告

> **2026-06-16 续档**：本报告的未决项已于 v4 重构期统一复核并吸收，活跃台账见 [`../06-inherited-issues.md`](../06-inherited-issues.md)（含每项实测状态 + v4 映射 + 处置）。本文件保留为历史归档。

> 审查日期：2026-06-03
> 范围：除 WebSocket 子系统外的所有核心模块
> 审查者：独立 subagent
>
> **更新 2026-06-03**：H1+H2 已实施 + 第二轮 subagent review 发现的 H2/M2/M3/M4/L1/L2 全部修复。
> 见文末「实施状态」。

## 总体评价

整体架构成熟度较高。Request Pipeline 采用策略模式后将 retry 决策从 handler 剥离干净，messages / chat-completions / responses 三条 handler 共享同一 `executeRequestPipeline` 框架，可观测性钩子（`requestContext.beginAttempt` / `setAttemptError` / `setAttemptEffectiveRequest`）覆盖到位；feature-negotiation 持久化、自适应速率限制三态机、SQLite history 双层（in-flight + 持久层）等子系统都体现出经过迭代打磨的痕迹。`request-telemetry.ts` 最近补上了 atomic write + serialized chain，是一次很好的 root-cause 修复样板。

主要遗留问题集中在两类：

1. **持久化原子性不一致** — telemetry 已经做了 atomic write + chained serialization，但 `feature-negotiation.ts`（`negotiation-states.json`）和 `auto-truncate/engine.ts`（`learned-limits.json`）仍然是裸 `fs.writeFile` + debounce-but-no-serialize 模式。是同一类 bug 的复制粘贴遗留。
2. **请求生命周期中"上游不替消费端做裁剪决策"原则的违背** — Pipeline 中多处对外部传入的对象做就地 mutation（`anthropicPayload.model = resolvedModel`、`response.model = normalizeModelId(...)`），违背 immutability 原则，也让"原始客户端请求"和"经过处理的请求"边界模糊。

其它发现集中在静默失败（事件监听器异常吞掉）、消费端复用昂贵衍生数据（`extractPreviewText` / `extractSearchText` 每次 WS 推送都重新遍历整个 messages）、以及 OpenAI sanitize / translate 中的对称性缺失。

## CRITICAL

无 Critical 级别问题。所有高风险路径都有兜底机制或被 maxRetries 上限保护。

## HIGH

### H1. `feature-negotiation.ts` 的 `persistFeatureNegotiation` 没有 atomic write

**文件**：`src/lib/anthropic/feature-negotiation.ts:192-205`
**根因**：与 `request-telemetry.ts:507-508`（已修复）完全相同的反模式。`schedulePersist` debounce 仅防止同一窗口内多次入队，不阻止上一轮持久化未完成时下一轮启动；shutdown 调用 `persistFeatureNegotiation()` 时也无序化。
**影响**：crash / kill -9 / 并发写入交错 → `negotiation-states.json` 损坏 → `loadPersistedFeatureNegotiation` 的 `JSON.parse` 抛错被 `catch {}` 吞掉（line 245-247）→ 所有学到的 feature/beta/effort/deferred-tools **静默归零**。每次踩到 "Tool reference not found"、"unsupported beta header"、"Extra inputs are not permitted" 时都要重新走 retry round-trip。
**修复方向**：抽取共享 `atomicWriteJson(path, data)` 工具，迁移 telemetry / negotiation / learned-limits 三处使用方。

### H2. `auto-truncate/engine.ts` 的 `persistLimits` 同样没有 atomic write

**文件**：`src/lib/auto-truncate/engine.ts:214-222`
**根因**：与 H1 完全相同。
**影响**：learned-limits 损坏 → auto-truncate 预检查清零 → 每模型遇 token-limit 时多走一次失败 round-trip。
**修复方向**：同 H1，复用同一 `atomicWriteJson`。

### H3. `executeInRecoveringMode` 并发请求间的竞态导致 lastRequestTime 失效

**文件**：`src/lib/adaptive-rate-limiter.ts:195-240`
**根因**：与 `processQueue`（rate-limited 模式下是 sequentialized while-loop）不同，`executeInRecoveringMode` 没有任何 sequentialization。在 recovering 模式下并发发起 N 个请求，所有都看到相同 `lastRequestTime`，全部 sleep 到同一时刻后**同时**调用 `fn()`，gradual-recovery 限速完全失效。
**影响**：ramp-up 阶段无法实际限速，立即触发 429 反弹回 rate-limited；日志反复出现 "Hit rate limit during ramp-up" 且 ramp-up 步骤永远不能完成。
**修复方向**：recovering 模式下也用 queue 单线程化，或用 `lastRequestAcquiredAt` mutex（leaky-bucket）。

### H4. `mark...Unsupported` 系列调用的副作用对 retry 策略不安全

**文件**：`src/lib/request/strategies/unsupported-beta-retry.ts:47-69`、`src/lib/request/strategies/context-management-retry.ts:80-113`
**根因**：策略在 negotiation 缓存中标记 token/field 不支持，然后返回**未修改的 payload**，依赖 `prepareAnthropicRequest` 在下次 attempt 重新读缓存过滤。这是隐式且脆弱的全局可变状态耦合：若 reviewer 优化 adapter 缓存 prepared payload（memoize 同一 payload 引用），retry 静默失效（再次报同样错，maxRetries 耗尽返回 400）。`meta` 中也无任何标记说明"payload 内容会被下游 prepare 重新过滤"。
**影响**：当前不出错，但任何 adapter 层调整都可能让两个 retry 策略静默退化；测试覆盖盲区。
**修复方向**：策略中显式从 payload 移除字段 / beta token 并通过 `action.payload` 返回。Negotiation 缓存作为下次新请求的优化路径，不作为本次 retry 的唯一传递机制。

## MEDIUM

### M1. RequestContext.complete() 改写调用方的 ResponseData
**文件**：`src/lib/context/request.ts:282`
`response.model = normalizeModelId(response.model)` 改写 caller 传入的对象。违反 CLAUDE.md 不可变原则。修复：`_response = { ...response, model: ... }`。

### M2. `handleMessages` mutate 入站 payload，"originalRequest" 名实不符
**文件**：`src/routes/messages/handler.ts:81, 87, 132`
依次把 `anthropicPayload.model / .system / .messages` 替换为加工后版本，然后 `reqCtx.setOriginalRequest({ ..., payload: anthropicPayload })`。`originalPayload` 实际是"半加工过"的，与 auto-truncate 策略中"从 original 重新截断"假设相违。修复：先 deep-clone 一份给 history。

### M3. 事件监听器异常被无声吞掉
**文件**：`src/lib/context/manager.ts:143-145`、`src/lib/context/request.ts:96-98`
history-consumer / tui-consumer 中任何 bug 都会被静默；至少应该 `consola.warn` 一行。

### M4. `toEntrySummary` 在每次 update 都重算 preview/search 文本
**文件**：`src/lib/history/entries.ts:23, 73`（在 `putInFlight` / `updateInFlight` 后调用）
`extractPreviewText` 和 `extractSearchText`（`in-flight.ts:34-115`）遍历**全部 messages、所有 content blocks**。长对话 + 频繁 SSE 累积 update（attempts/queueWaitMs/pipelineInfo 变更）→ O(updates × messages × blocks)，全部走 WebSocket 推送。
**修复方向**：preview/search 只在 originalRequest 首次设置时算一次，缓存到 in-flight entry。

### M5. `INSERT OR REPLACE` + session token 累加 → 潜在重复计数
**文件**：`src/lib/history/sqlite/write.ts:33-76`
`entries` 表用 REPLACE 但 `sessions` 表用 `request_count = request_count + 1` 与 `+ excluded.total_input_tokens`。同一 entry.id 被插入两次时 sessions 数据 double-count。当前流程不会触发，但缺乏防御性约束。
**修复方向**：用 `INSERT OR IGNORE` 然后 changes=0 时跳过 session upsert,或 sessions 改为 subquery-aggregate。

### M6. `cc-to-responses.ts` tool_call_id 缺失时默默使用空串
**文件**：`src/lib/openai/translate/cc-to-responses.ts:182`
`call_id: message.tool_call_id ?? ""` —— 空串让 Responses API 后续匹配失败。应抛 `HTTPError(400, "tool message missing tool_call_id")`。

### M7. `convertAssistantMessage` 可能返回空数组导致 assistant turn 消失
**文件**：`src/lib/openai/translate/cc-to-responses.ts:145-168`
无 text 无 tool_calls 的 assistant 消息整条丢弃。应至少 warn 或注入占位。

### M8. `sanitizeOpenAIMessageContent` 对全空消息保留原值，破坏对称性
**文件**：`src/lib/openai/sanitize.ts:33-40`
当一条消息整段是 system-reminder，sanitized 为空，函数选择"保留原文不动"——越是该删的越删不掉。与 Anthropic 侧的 prune 路径语义不一致。

### M9. context manager reaper 间隔硬编码 60s
**文件**：`src/lib/context/manager.ts:100` `REAPER_INTERVAL_MS = 60_000`
`staleRequestMaxAge` 可配置但扫描频率不可配置。调到 30s 以下时，reaper 仍 60s 节奏扫描，最大检测延迟 90s+。
**修复方向**：派生自 `staleRequestMaxAge` 或新增独立 config。

## LOW（精选）

- **L1**：`src/lib/openai/orphan-filter.ts:110` `ensureOpenAIStartsWithUser` 已实现但 orchestrator (`sanitize.ts`) 中没有调用——漏接线或纯示范死代码。
- **L2**：`src/lib/request/pipeline.ts:205` `throw lastError instanceof Error ? lastError : new Error("Unknown error")` 把非 Error 异常包成 `"Unknown error"`，丢原始诊断信息。应 `new Error(String(lastError))`。
- **L3**：`src/lib/request/recording.ts:18-25` `mapAnthropicContentBlocks` 多余的 `"text" in block` 守卫（前一行已 `block.type !== "text"` 才放行）。
- **L4**：`src/lib/context/manager.ts:181-186` 和 `:203-208` 两段 `recordSettledRequest` 调用几乎完全重复，可提取辅助函数。
- **L5**：`src/lib/anthropic/message-tools.ts:32-49` `CLAUDE_CODE_OFFICIAL_TOOLS` / `NON_DEFERRED_TOOL_NAMES` 硬编码常量，非 Claude Code 客户端无法关。

## 🎯 推荐「下一刀」

### 抽取 `atomicWriteJson` 工具并统一三处持久化路径

**为什么是它**：

1. **真实存在** — `request-telemetry.ts` 已被这类问题坑过一次（见 `src/lib/request-telemetry.ts:104-110` 的明确注释，corrupted 文件会清零 7 天历史）。同样反模式在 `feature-negotiation.ts:192-205` 和 `auto-truncate/engine.ts:214-222` 原封不动地存在，是已知 bug 的复制粘贴。
2. **影响面广** — feature-negotiation 文件存储**所有学到的上游兼容性知识**（rejected fields、betas、deferred tools、effort whitelists），损坏后影响每一种重试策略；learned-limits 文件影响每个模型的 auto-truncate 预检查。数据丢失不让请求失败，但会让用户感受到"原来稳定的体验突然需要多次失败 round-trip 才能完成"——典型的"易被忽视的退化"。
3. **没被现有测试覆盖** — 测试都是 mark+load 单元层面，没有 crash 注入 / 并发 write 场景。
4. **修复有明确架构收益** — 从"重复反模式"到"单一权威工具"的重构，符合"类型/工具单一权威来源"原则。

**修复架构示意**：

```ts
// src/lib/utils/atomic-fs.ts (新文件)
export async function atomicWriteJson<T>(targetPath: string, data: T): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8")
    await fs.rename(tmpPath, targetPath)
  } catch (err) {
    void fs.unlink(tmpPath).catch(() => undefined)
    throw err
  }
}

export function serializeWrites<T extends (...args: never[]) => Promise<unknown>>(fn: T): T {
  let chain: Promise<unknown> = Promise.resolve()
  return ((...args) => {
    const next = chain.then(() => fn(...args))
    chain = next.catch(() => undefined)
    return next
  }) as T
}
```

迁移路径：1) 新文件 + 测试；2) `request-telemetry.ts` 内联实现替换；3) `feature-negotiation.ts:192-205` 用 `atomicWriteJson` + `serializeWrites` 包；4) `auto-truncate/engine.ts:214-222` 同上。

**预估改动范围**：新文件 ~50 行；改 3 文件每处 5-10 行；测试 ~80 行；总改动 <200 行，全在 `src/lib/`，无 handler/route 影响。

**测试策略**：单元（写后 valid JSON、中断后原文件不变）+ 集成（50 并发 persist，最终 read 出最后 mark 的状态且 JSON.parse 不抛）。

## 已发现但归档的项

- **TUI reasoning_tokens 字段穿透**：`consumers.ts:174-178` 没传 reasoning_tokens。不优先：TUI 即将被 webui v3 替代。
- **`stripBetaHeaders` / `rejectBodyFields` wildcard "\*" key 实现**：未打开 `request-preparation.ts`。不优先：已被现有单测间接验证。
- **`models/resolver.ts:217-247` chained alias + family fallback**：可能产生反直觉跳转。不优先：当前无实际触发配置。
- **`history/in-flight.ts` 模块级单例 Map**：测试间串扰。不优先：已有 reset 机制。
- **`message-mapping.ts:15-37` 100-prefix 字符串匹配**：截断/续接边界 false-positive 风险。不优先：仅用于 mapping 重建，错误时 fallback -1。
- **`pipeline.ts` 抛错时丢失中间 attempts ResponseData**：实际通过 `_attempts[i].error` 仍保留，可观测性完整。
- **`adaptive-rate-limiter.ts processQueue` 单循环 + processing 标志**：未来加 priority queue 难扩展,当前业务不需要。

---

## 实施状态（2026-06-03 更新）

### ✅ 「下一刀」H1+H2 — 抽取 `atomicWriteJson` + `createSerializedAsyncFn`

**新增**：`src/lib/atomic-fs.ts`（atomicWriteJson + createSerializedAsyncFn + tmpSeq counter）
**迁移**：`request-telemetry.ts` / `feature-negotiation.ts` / `auto-truncate/engine.ts` 三处统一到 atomic-fs
**测试**：`tests/unit/atomic-fs.test.ts` — 9 个测试，100% 覆盖。包含 crash 注入（stub writeFile 失败后 target 文件不变 + tmp cleanup）、并发 50 写入（serialized 最后一个赢 + valid JSON）、反例（raw 并发不保证 last-invoked 赢）。

### ✅ 第二轮 subagent review 发现问题（全部修复）

- **H2 — `request-telemetry.ts` 声明顺序 TDZ**：`persistTelemetrySerialized const` 上移到 `persistRequestTelemetry export` 之前
- **M2 — `feature-negotiation` reset 不排空 chain**：改为 async，先 `await persistFeatureNegotiation()` 排空再 clear；4 个测试 callsite 跟着改成 async
- **M3 — 反例测试断言过刚**：`expect(parsed.n).toBe(0)` → `expect(parsed.n).not.toBe(2)`，CI 调度抖动友好
- **M4 — `engine.ts:persistLimits` 静默吞错**：补 `consola.debug("[AutoTruncate] persist failed:", err)`
- **L1 — `shutdown.ts:410` shutdown 等待语义注释**：明示 serialized chain FIFO 保证 + fire-and-forget 意图
- **L2 — atomic-fs tmp 文件名碰撞窗**：加 `tmpSeq++` 单进程单调计数器，消除同毫秒并发碰撞

### 验证

- typecheck: ✅ pass
- lint: ✅ 本轮改动的所有 src/tests 文件零错
  （`tests/unit/deferred-tool-retry-strategy.test.ts` 中 9 个 `any` cast / non-null assertion 是用户 WIP 内容，与本轮无关）
- tests: ✅ 1633 pass / 0 fail / 3 skip （1636 total，含 9 个新 atomic-fs 测试）

### 仍未做（按优先级低，等触发）

H3（adaptive rate-limiter recovering 模式并发竞态）、H4（mark...Unsupported 副作用）等本轮 audit 中 HIGH/MEDIUM 项保持原报告状态。下次单独迭代处理。

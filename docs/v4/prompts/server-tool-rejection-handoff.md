# 交接文档 — Server-Tool Rejection 自愈重试策略（v4）

> **本文档自包含**：完整记录设计共识与实现规格。新会话只需读本文档即可独立实现。
> **状态**：设计已与用户逐项敲定并批准；**尚未实现任何代码，尚未提交任何 git**。
> **背景**：本设计会话曾因 confabulation（把诚实的 `test -f`/`git add` 输出误判为"被伪造"）中断——该幻觉案例原文已归档至 [docs/archive/hallucination/suspect-self-before-environment.md](../../archive/hallucination/suspect-self-before-environment.md) §案例一（含本会话当时的矫正告诫原文）。非环境/工具故障，正常使用 Write 即可。

---

## 0. 新会话开场提示词（复制粘贴）

```
继续实现 v4 的 server-tool-rejection 自愈重试策略。

完整设计与实现规格在 docs/v4/prompts/server-tool-rejection-handoff.md —— 先完整读它。

要点：
- 错误驱动重试策略，捕获上游对 native web_search 的 400「The use of the web search
  tool is not supported.」(code unsupported_value)，写入 feature-negotiation 账本并
  剥离 web_search 工具重试，使后续同模型请求 pre-emptively 规避，不再 400。
- 设计已敲定：仅 web search / 无 config gate（默认开）/ 持久化进 feature-negotiation
  第五类 / 保持 feature-negotiation 命名 / 持久化位置不变 / 只做 v4 路由（legacy 不动）。
- 用中文。遵循 CLAUDE.md 全部原则（本地 commit 默认允许、远端 push 需明确同意；分阶段
  主动提交；改 .ts 后跑 typecheck/test；测试用 DI/临时目录不碰真实 $HOME）。

按交接文档「实现步骤」顺序执行：先写设计 spec docs/v4/03-spec/server-tool-rejection-retry.md
（交接文档第 9 节有完整内容），再 TDD 实现，每阶段提交。开始前 git status 确认工作区。
```

---

## 1. 背景

客户端发 native server tool（如 Claude Code 的 web_search_20250305）给不支持它的 Copilot 上游模型时，上游回：

    HTTP 400 {"error":{"message":"The use of the web search tool is not supported.","code":"unsupported_value"}}

现状：无任何 retry strategy 的 canHandle 命中此错误（pattern 与 effort/beta/field/deferred-tool 均互斥），请求直接 [FAIL]。唯一规避是预防配置 anthropic.strip_server_tools: true（无条件全局剥离，需手动开）。

目标：反应式自愈——只在真被拒后剥离、自动学习、持久记忆、对所有模型生效、无需预先配置。与 effort-learning / unsupported-beta / body-field-rejection 同族同构。

---

## 2. 决策记录（已敲定）

| 决策 | 选择 | 理由 |
|------|------|------|
| 范围 | 仅 web search | 只有 web search 有实证样本；其它 server tool 上游措辞未知，不臆测泛化 |
| 配置开关 | 无 gate，默认开 | 与所有自愈策略一致；反应式只在 400 触发，误剥风险低 |
| 持久化 | 写入 feature-negotiation 第五类 | 与 features/betas/efforts/deferredTools 一致；避免每会话首请求先 400 |
| 命名 | 保持 feature-negotiation | 不随本功能重命名 |
| 持久化位置 | 保持 negotiation-states.json | 与 history.db/config.yaml 统一在 appDir |
| 路由 | 只做 v4 | legacy anthropic/pipeline.ts 不动 |

非目标（YAGNI）：不泛化其它 server tool、不重命名、不改持久化位置、不注册 legacy。
cache 结构设计成通用 per-toolType（Set<serverToolType>，首期只填 web_search_），将来扩 web_fetch 只需扩 pattern。

---

## 3. 关键代码锚点（行号实现前复核）

- src/lib/anthropic/feature-negotiation.ts — 账本模块：4 类，modelKey()=endpoint|anthropic-messages|normalizeForMatching(model)，markAnthropicBetaUnsupported/isAnthropicBetaUnsupported 是镜像范本，NegotiationStateFile 结构，snapshotSetMap/loadSetMap 复用，resetAnthropicFeatureNegotiationForTesting
- src/lib/anthropic/message-tools.ts:~340 — stripServerTools(tools)；其上 ~313-326 有 SERVER_TOOL_TYPE_PREFIXES（web_search_/web_fetch_/code_execution_/…）+ isServerToolType(type)
- src/lib/anthropic/request-preparation.ts:~294 — buildWirePayload 内 wire.tools = stripServerTools(...) 调用点；PrepareMessagesOptions（含 excludeBetas）在 ~75；collectRejectedFields/filterUnsupportedBetas 是 hint+cache 合并消费范本
- src/lib/request/pipeline.ts:~91 — PrepareHints 接口（含 excludeBetas/rejectFields）
- src/lib/codec/anthropic.ts:~379 — env.prepareHints.excludeBetas/rejectFields 透传 prepare opts 范本
- src/lib/codec/anthropic-strategies.ts:~74 — v4 主注册点 buildAnthropicStrategies（env-based，adapt(...) 包 legacy）。顺序：network→token-refresh→effort-learning→body-field-rejection→legacy-thinking→unsupported-beta→deferred-tool→auto-truncate
- src/lib/request/strategies/unsupported-beta-retry.ts — 新策略最佳范本（canHandle 400+pattern、handle 返回 {action:"retry",payload,prepareHints,meta}、per-instance 状态、extractErrorText）
- src/lib/request/strategies/effort-learning-retry.ts — learn→cache→re-prepare + 一次性 attempted 标记范本
- src/lib/request/strategies/context-management-retry.ts — createBodyFieldRejectionStrategy：写 feature → buildWirePayload 读 范本
- src/routes/messages/handler-v4.ts:~189 — if (state.webSearchEnabled && payloadHasWebSearch(wireBody)) 双跳早退（在 runMessagesDriver 前）→ 证明与双跳零冲突

---

## 4. 实现步骤（按序，每步验证落盘 + 阶段提交）

Step 0 准备：git status 确认工作区；只新增文件 + 改几处，严格 file-line 暂存，勿裹入工作区既有无关改动（.claude/settings.json、CLAUDE.md、docs/DESIGN.md 等是用户既有改动，不碰不暂存）。先创建设计 spec docs/v4/03-spec/server-tool-rejection-retry.md（内容见第 9 节），提交 docs(v4): server-tool-rejection 策略设计。

Step 1 feature-negotiation 第五类（feature-negotiation.ts）：
- const unsupportedServerTools = new Map<string, Set<string>>()
- markAnthropicServerToolUnsupported(modelId, toolType) / getUnsupportedServerToolTypes(modelId)（镜像 betas 对，addToSetMap + schedulePersist）
- NegotiationStateFile 加 serverTools: Record<string,string[]>（version 仍 1，additive）；persist 加 serverTools: snapshotSetMap(unsupportedServerTools)；load 加 loadSetMap(unsupportedServerTools, data.serverTools)
- reset 加 unsupportedServerTools.clear()
- 顶部 JSDoc Categories 加第五条
- TDD：tests/anthropic/feature-negotiation-server-tools.unit.test.ts（mark/get + persist↔load round-trip 含旧文件缺键兼容 + reset）

Step 2 stripServerTools 改造（message-tools.ts）：
- 签名 (tools) → (tools, model, excludeTypes?)，三源并集（见 §9.3）：state.stripServerTools ∪ getUnsupportedServerToolTypes(model) ∪ excludeTypes
- 更新唯一调用点 request-preparation.ts:~294 → stripServerTools(wire.tools, payload.model, opts.excludeServerToolTypes)
- import 环核实（message-tools → feature-negotiation 不成环，跑 typecheck 确认）
- TDD：tests/anthropic/strip-server-tools-learned.it.test.ts

Step 3 PrepareHints 链路 4 登记点：excludeServerToolTypes?: ReadonlyArray<string> 加到 pipeline.ts PrepareHints → codec/anthropic.ts 透传 → request-preparation.ts PrepareMessagesOptions → buildWirePayload 传 stripServerTools

Step 4 新策略（src/lib/request/strategies/server-tool-rejection-retry.ts，见 §9.2）+ TDD tests/pipeline/server-tool-rejection-retry.unit.test.ts（canHandle 互斥矩阵 + handle）

Step 5 注册（v4 only）：codec/anthropic-strategies.ts:~74 unsupported-beta 后、deferred-tool 前：adapt(createServerToolRejectionStrategy<MessagesPayload>())

Step 6 端到端：tests/anthropic/server-tool-rejection.http.test.ts（fetch-mock 首发 400、二发 200 → 最终 200 + 二跳 wire 无 web_search + cache 已写；autoRestoreState + resetAnthropicFeatureNegotiationForTesting）

Step 7 验证 + 文档回填：bun run typecheck + bun run test:backend + bun run lint:all（eslint --fix）；回填 DESIGN.md stripServerTools 行（三源并集）、retry-transport.md 策略索引；分阶段提交（feat(transport): … 风格，不带 Co-Authored-By）

---

## 5. 数据流

client 带 native web_search + 模型不支持 + webSearchEnabled=false
→ pipeline 发上游 → 400 "web search tool is not supported"
→ server-tool-rejection.canHandle ✓ → mark cache + prepareHints.excludeServerToolTypes=["web_search_"]
→ retry: re-prepare → stripServerTools 剥 web_search_* → 上游 200（degraded 无搜索）
后续同 (endpoint,model) → prepare 直接读 cache 剥离 → 首跳即 200

与 web_search 双跳零冲突：双跳在 handler-v4.ts:~189 于 pipeline 前早退；只有 webSearchEnabled=false 才进 pipeline 触发本策略。正交。

---

## 6. 错误处理 / 边界
- 剥离后 tools 空 → stripServerTools 返 undefined（纯文本回答，可接受 degradation）
- 死循环防御：mark 后 cache 幂等，同请求内 attempted flag 兜底
- 剥离后仍 400（不应发生）→ normal retry 预算耗尽 → [FAIL]，诊断经 setAttemptError 保留

---

## 7. 测试归属
- 策略单测 → tests/pipeline/*.unit.test.ts
- cache + stripServerTools + 端到端 → tests/anthropic/，后缀 .unit/.it/.http
- 隔离：DI/fetch-mock 不用 mock.module；mutate 全局 state 加 autoRestoreState()；fs I/O 用注入临时目录不碰真实 $HOME
- 跑测试用 bun run test:backend（非 npm run）

---

## 8. 注意事项
- 远端 push / 改写已推送历史 / 删分支 需用户明确同意；本地 add/commit/分支默认允许
- 绝不 git checkout/restore <file> / reset --hard / clean -f / rm 工作区文件
- 暂存严格 file-line，提交前 git diff --cached --stat 复核，勿裹入既有无关改动
- 不自动启服务器、不 kill 进程
- 改 .ts 才需 typecheck/test；纯 .md 不需要
- 类型单一权威来源；同模块导入用相对路径 ./foo
- 不为迁就 prettier 扭曲代码（printWidth 160）；不删有意义注释

---

## 9. 完整实现规格（即 docs/v4/03-spec/server-tool-rejection-retry.md 应有内容）

### §9.1 feature-negotiation 第五类
    const unsupportedServerTools = new Map<string, Set<string>>()
    export function markAnthropicServerToolUnsupported(modelId: string, toolType: string): void {
      const trimmed = toolType.trim()
      if (!trimmed) return
      if (addToSetMap(unsupportedServerTools, modelKey(modelId), trimmed)) schedulePersist()
    }
    export function getUnsupportedServerToolTypes(modelId: string): Array<string> {
      const set = unsupportedServerTools.get(modelKey(modelId))
      return set ? [...set] : []
    }
NegotiationStateFile 加 serverTools: Record<string,string[]>；persist 加 serverTools: snapshotSetMap(unsupportedServerTools)；load 加 loadSetMap(unsupportedServerTools, data.serverTools)；reset 加 .clear()。

### §9.2 新策略
    const WEB_SEARCH_NOT_SUPPORTED = /the use of the web search tool is not supported/i
    export function createServerToolRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
      let attempted = false
      return {
        name: "server-tool-rejection-retry",
        canHandle(error) {
          if (error.type !== "bad_request" || error.status !== 400) return false
          if (attempted) return false
          const text = extractErrorText(error)
          return !!text && WEB_SEARCH_NOT_SUPPORTED.test(text)
        },
        handle(error, currentPayload) {
          attempted = true
          markAnthropicServerToolUnsupported(currentPayload.model, "web_search_")
          return Promise.resolve({
            action: "retry",
            payload: currentPayload,
            prepareHints: { excludeServerToolTypes: ["web_search_"] },
            meta: { strippedServerTools: ["web_search_"] },
          })
        },
      }
    }
注：RetryStrategy 精确接口、extractErrorText、RetryAction 字段以 unsupported-beta-retry.ts 为准对齐。attempted 放 canHandle 还是仅靠 cache 幂等，参考 effort-learning 实测确认。

### §9.3 stripServerTools 三源并集
    export function stripServerTools(
      tools: Array<Tool> | undefined,
      model: string,
      excludeTypes?: ReadonlyArray<string>,
    ): Array<Tool> | undefined {
      if (!tools) return undefined
      const learned = new Set([...getUnsupportedServerToolTypes(model), ...(excludeTypes ?? [])])
      const stripAll = state.stripServerTools
      if (!stripAll && learned.size === 0) return tools
      const result: Array<Tool> = []
      for (const tool of tools) {
        if (isServerToolType(tool.type) && (stripAll || [...learned].some((p) => (tool.type ?? "").startsWith(p)))) {
          consola.warn(`[DirectAnthropic] Stripping server tool: ${tool.name} (type: ${tool.type})`)
          continue
        }
        result.push(tool)
      }
      return result.length > 0 ? result : undefined
    }

### §9.4 PrepareHints 链路 4 登记点
excludeServerToolTypes?: ReadonlyArray<string> 加到 pipeline.ts PrepareHints → codec/anthropic.ts 透传 → request-preparation.ts PrepareMessagesOptions → buildWirePayload 传 stripServerTools。

### §9.5 注册
codec/anthropic-strategies.ts unsupported-beta 后、deferred-tool 前：adapt(createServerToolRejectionStrategy<MessagesPayload>())。legacy anthropic/pipeline.ts 不注册。

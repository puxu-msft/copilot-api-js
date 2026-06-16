# Deferred Items — 已知但未在本轮 scope 的真实问题

> **2026-06-16 续档**：本文件各 DI 项已于 v4 重构期实测复核并吸收，活跃台账见 [`../06-inherited-issues.md`](../06-inherited-issues.md)。复核结论：DI-6/11/12 已闭合（已修/过时），DI-3/2/10/9/14 归 v4 实施视野，DI-5 方案已定（append-only recovery log），DI-4/7/13/1 为 v4 外独立 backlog。本文件保留各项完整上下文。

> 创建：2026-06-03
> 范围：subagent 多轮 review 中发现 / audit 中归档的真实问题，但因「scope 外」未在本轮处理
>
> **本文档不是 backlog**。每一项都是真实存在、值得未来认真解决的工程改进。用户原则：所有真实问题都应认真全面修复，本文档作为下次决策的完整上下文存在。

## 索引

- [DI-1: HistoryEntry / OriginalRequest 类型层不可变保护](#di-1)
- [DI-2: structuredClone 性能基线](#di-2)
- [DI-3: handler payload mutation 重构为 immutable transform pipeline](#di-3)
- [DI-4: finalizeEntry idempotency 显式契约](#di-4)
- [DI-5: 持久化失败时 in-flight 清空策略文档化](#di-5)
- [DI-6: wire-mutate 函数统一不变量自检](#di-6)
- [DI-7: M9 reaper 派生公式单元测试](#di-7)
- [DI-8: Azure override channel 端到端测试](#di-8)
- [DI-9: cc-to-responses M6 错误带 message index](#di-9)
- [DI-10: M7 / M8 空消息策略哲学冲突](#di-10)
- [DI-11: TUI reasoning_tokens 字段透传](#di-11)
- [DI-12: models/resolver chained alias + family fallback 行为](#di-12)
- [DI-13: in-flight 模块级单例 Map 测试隔离](#di-13)
- [DI-14: message-mapping 100-prefix 字符串匹配 false-positive](#di-14)

---

## DI-1

### HistoryEntry / OriginalRequest 类型层不可变保护

**位置**：`src/lib/history/types.ts:169`（HistoryEntry）、`src/lib/context/request.ts` 的 `OriginalRequest` 接口、`src/lib/history/in-flight.ts:17`（WeakMap memoize）

**根因**：本轮 M2 通过 `structuredClone` 在 handler 入口抓 snapshot 防止 mutation 污染；M4 用 WeakMap 缓存 preview/search text。两个保护都依赖**约定**：「caller 不会 mutate already-registered HistoryEntry」「snapshot 后不会再修改 originalSnapshot」。**TypeScript 没有 `DeepReadonly` 强制**。

**当前行为**：约定靠 code review 保证。任何未来 caller 直接 `entry.request.messages.push(...)` 不会被类型层拒绝；WeakMap cache 返回 stale 数据，preview/search 滞后。

**理想架构**：
- 把 `HistoryEntry` 标 `DeepReadonly<HistoryEntry>`（自定义工具类型或第三方）
- `OriginalRequest` 接口同样标 `readonly` / `DeepReadonly`
- 开发模式（`NODE_ENV !== "production"`）下，`putInFlight` 入口对 entry 做 `Object.freeze` 递归冻结（避免运行时开销但能 catch dev mutation）

**为什么未在本轮做**：DeepReadonly 类型工具会让现有几十处 cast 全失败；引入需要全代码库一致改造。本轮 scope 是 audit items，这是新增加固。

**修复后改变**：未来类似 mutation 引入的 bug 在编译期 / 开发时立即报错，不靠 review。

---

## DI-2

### structuredClone 性能基线

**位置**：`src/routes/messages/handler.ts:82`、`chat-completions/handler.ts:65`、`responses/handler.ts:85`、`responses/ws.ts:160`

**根因**：M2 在 4 个 handler 入口处无条件 `structuredClone(payload)`。对常见对话（<200KB）成本 <1ms 可忽略；对含 base64 图像的 vision 请求（4-20MB）可能 50-100ms。**没有基线测试**。

**当前行为**：每个请求都承担 clone 开销。SLO/P99 监控可能首次发现这点。

**理想架构**：
- 加性能测试：4MB payload 平均 < 10ms、20MB < 50ms（机器相关，加 CI envvar 跳过）
- 若证实是问题，考虑只 clone 「被 mutate 的子字段」（messages/system/tools/...），但这让契约更隐式
- 或：用 `WeakRef` + COW，仅当首次 mutation 发生时才 clone（复杂但理论最优）

**为什么未在本轮做**：当前没有用户报告延迟问题；过早优化。需先基线测量再决定是否优化。

**修复后改变**：vision 高负载场景 P99 减少 50-100ms。

---

## DI-3

### handler payload mutation 重构为 immutable transform pipeline

**位置**：3 个 handler 加 ws — `messages/handler.ts` 的 `payload.model =`、`payload.system =`、`payload.messages =`；`chat-completions/handler.ts` 同款；`responses/handler.ts` 同款

**根因**：M2 通过 snapshot 解决了 「originalRequest 失真」的症状。**真正的架构问题是 handler 入口处 mutate 入站 payload**——`resolveModelName(payload) → newPayload` 应该是 pure function。

**当前行为**：handler 第一段都是 mutate-in-place 风格。snapshot 是补救。Azure override channel 已经走了第一步（不再 mutate body）。

**理想架构**：
- `resolveModel(payload) → payload`（返回新对象）
- `processSystem(payload) → payload`
- `preprocessMessages(payload) → payload`
- handler 主流程是函数组合：`pipe(resolveModel, processSystem, preprocessMessages)(originalPayload)`
- snapshot **不再需要**（originalRequest 自然就是原 payload）
- M-rev-5 DEEP_CLONE_FIELDS / H1 thinking deep clone **也不再需要**（每个 transform 自己返回新 payload，不依赖 deep clone 防泄漏）

**为什么未在本轮做**：这是 handler 重构，scope 远大于本轮。每个 transform 函数需要新定义、单元测试。但**这是最干净的架构**。

**修复后改变**：M2 snapshot 删除、M-rev-5 / H1 DEEP_CLONE_FIELDS 删除、retry 路径上的 payload 完全无副作用。Handler 代码读起来像「函数式 pipeline」。

---

## DI-4

### finalizeEntry idempotency 显式契约

**位置**：`src/lib/history/entries.ts:82` `finalizeEntry`

**根因**：本轮拆出 finalizeEntry。当前实现 `getInFlight(id) → undefined → return` 是**隐式幂等**：调两次第二次安静无效。docstring 没写明这条契约。

**当前行为**：双调用安全，但 caller 没法分辨「entry 已 finalize」vs「entry 不存在」（如 typo 传错 id）。

**理想架构**：
- docstring 显式声明 idempotency
- 或：返回 boolean 表示是否真的 finalize 了（让 caller 决定如何处理「没找到」）
- 测试覆盖双调用 + 不存在 id 两个 case

**为什么未在本轮做**：当前唯一 caller（consumer.ts）天然单次调用；不是真实 bug，是契约文档不全。

**修复后改变**：未来 caller 不会因为「调两次会不会出问题」而踩坑。

---

## DI-5

### 持久化失败时 in-flight 清空策略文档化

**位置**：`src/lib/history/entries.ts:97-109` `finalizeEntry`

**根因**：当 `insertCompletedEntry` 抛错（ENOSPC / SQLite corrupt / permission），current behavior 是 `consola.warn` + **仍然 `removeInFlight(id)`**。**entry 永久丢失**：SQLite 没有，in-flight 没有。

**当前行为**：一次性丢一条 entry。日志只有泛化 warn，没有 id/endpoint/model 上下文。

**理想架构**（两种方向，需用户决策）：
- **保留语义**：写 docstring 明示 "若 SQLite 写失败仍清 in-flight，避免无界内存增长；可接受 WS 最终状态可能不一致"，warn 中包含 id+endpoint+model+error
- **保留 in-flight**：失败时不清 in-flight，让 ops 能拉取诊断；但需要 LRU 防内存堆积；需要标记「待重试」状态

**为什么未在本轮做**：需要用户决策保留语义。

**修复后改变**：磁盘故障时不再静默丢数据，至少有可追溯日志。

---

## DI-6

### wire-mutate 函数统一不变量自检

**位置**：`src/lib/anthropic/request-preparation.ts` 的 `adjustThinkingBudget` / `clampEffortLevel` / `applyCacheControlMode` / `addToolsAndSystemCacheControl` 等

**根因**：M-rev-5 + H1 已通过 `DEEP_CLONE_FIELDS` 拦截了 4 个字段的 mutation 泄漏。但**未来任何新的 mutate 函数操作新字段，仍会重复同样的 bug**。

**当前行为**：靠 DEEP_CLONE_FIELDS 集合手动维护。新增字段需要手动 grep。

**理想架构**：
- 开发模式下，在 `prepareAnthropicRequest` 结束后 deep-equal 比对 wire vs payload 的非 cloned 字段
- 任何 wire 写回 payload 的 mutation 立即在开发时 assert 失败
- 或：DI-3 immutable transform pipeline 让这个问题彻底消失

**为什么未在本轮做**：自检机制本身需要设计；与 DI-3 重叠（DI-3 完成则本项不需要）。

**修复后改变**：未来 mutation bug 在 dev 时立即捕获，不靠 review。

---

## DI-7

### M9 reaper 派生公式单元测试

**位置**：`src/lib/context/manager.ts:117-127` `computeReaperIntervalMs`

**根因**：M9 改 reaper interval 派生自 `staleRequestMaxAge / 3` + clamp 250ms-60s。**没有单元测试**覆盖：
- maxAge=0 → 60s （但 startReaper 已 guard 不 schedule，OK）
- maxAge=1s → 333ms
- maxAge=750s → 60s（clamp）
- 热重载 staleRequestMaxAge 不重排 timer 的现有行为

**当前行为**：派生公式只在生产路径间接被测试到，边界值无回归保护。

**理想架构**：直接测 `computeReaperIntervalMs`（需要 export 或 reflect via getter）。

**为什么未在本轮做**：函数当前是 inner closure，不易测；导出会破坏封装。

**修复后改变**：派生公式回归保护，未来调整 clamp/factor 安全。

---

## DI-8

### Azure override channel 端到端测试

**位置**：`src/routes/azure-openai/route.ts` 的 `azureModelOverride` channel + 3 个 handler 的消费路径

**根因**：本轮把 Azure body.model mutation 改为 `c.set("azureModelOverride", deployment)` channel。**没有端到端测试**断言 Azure 请求路径正确应用 override。

**当前行为**：单元测试覆盖 handler 个别行为，Azure 调用链整体未验证。

**理想架构**：3 个 component 测试，模拟 `app.request("/openai/deployments/dep-x/...")`，断言 history 中的 originalRequest.model == body 中原值（非 dep-x），effectivePayload.model == "dep-x"。

**为什么未在本轮做**：scope 控制；现有 Azure 路径 e2e 测试假设它工作，没明确验证 model override。

**修复后改变**：Azure 行为有显式契约测试。

---

## DI-9

### cc-to-responses M6 错误带 message index

**位置**：`src/lib/openai/translate/cc-to-responses.ts:172-200`

**根因**：M6 修复了 tool_call_id 缺失时抛 HTTPError(400)，但**错误信息只有「missing tool_call_id」**，没有指出是 messages 数组的哪个 index。客户端 debug 难以定位。

**当前行为**：用户看到通用错误，需要逐条排查 tool messages。

**理想架构**：抛错信息包含 `messages[index] role=tool` 等定位信息。

**为什么未在本轮做**：`convertToolMessage` 当前签名不接 index；要传需要从 caller 改链路。

**修复后改变**：错误信息可定位到具体 message。

---

## DI-10

### M7 / M8 空消息策略哲学冲突

**位置**：M7 在 `cc-to-responses.ts:178-193`「注入空 placeholder + warn」；M8 在 `openai/sanitize.ts:38-89`「全空消息删除」

**根因**：subagent 第二轮 review 指出二者哲学相反——M7 选择「保留 turn 结构」，M8 选择「彻底删除」。当 sanitize 后 message 空、且这是 cc-to-responses 路径的 assistant turn 时，会先被 M8 删，然后 M7 都没机会 inject 占位。

**当前行为**：依赖调用顺序：cc-to-responses 在 ChatCompletions → Responses 路径上 sanitize 之后跑；如果 Responses 路径自己再 sanitize，可能出现 sanitize 后 M7 注入占位再被「Final safety net」（sanitize.ts:147-156）的 filter 又删掉。

**理想架构**：统一一个原则。可选：
- 全部「保留 turn」：sanitize 删 message 改为「换成 placeholder」
- 全部「彻底删除」：cc-to-responses 空 turn 也删（影响对话连贯性）
- 文档化二者的「作用域不重叠」（cc-to-responses 仅作用于 Responses 输入侧，sanitize 仅作用于 ChatCompletions 输入侧）并加 invariant 测试

**为什么未在本轮做**：调用顺序梳理需要画完整 sanitize / translate 数据流图。

**修复后改变**：策略一致，无边界 case bug。

---

## DI-11

### TUI reasoning_tokens 字段透传

**位置**：`src/lib/context/consumers.ts:174-178` 的 tui consumer

**根因**：consumers.ts 把 response usage 字段透传给 tuiLogger，但**漏了 reasoning_tokens**。TUI 不显示 reasoning tokens 数。

**当前行为**：reasoning model 的 token 消耗在 TUI 中不可见。

**理想架构**：补 `reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? undefined`。

**为什么未在本轮做**：audit 注释「TUI 即将被 webui v3 替代」——但 webui 替代时间不明，TUI 仍在运行。

**修复后改变**：reasoning model 用户在 TUI 中能看到 reasoning 部分的 token 成本。

---

## DI-12

### models/resolver chained alias + family fallback 行为

**位置**：`src/lib/models/resolver.ts:217-247`

**根因**：alias 解析→family fallback 链可能产生反直觉跳转（用户配置 `haiku: claude-sonnet-4.6` + 想要 sonnet 不可用时 fallback 到 family default → 可能跳回到 haiku）。

**当前行为**：现有配置下不触发（用户 config.yaml 没踩到此组合），但路径存在。

**理想架构**：
- 加 cycle 检测（resolver 维护 visited set，防止 alias 循环回到自身）
- 加 fallback 决策日志（resolver 每次 fallback 输出 debug log）

**为什么未在本轮做**：无实际触发；新增 cycle 检测改 resolver API。

**修复后改变**：复杂 model_overrides 配置下行为可预测。

---

## DI-13

### in-flight 模块级单例 Map 测试隔离

**位置**：`src/lib/history/in-flight.ts:3` `const entries = new Map<string, HistoryEntry>()`

**根因**：模块顶级单例。测试通过 `clearInFlight()` 重置，但**WeakMap memoize cache 不被清**（WeakMap 跟随 entry 实例 GC，但测试间残留 entry 实例可能被 cache hold）。

**当前行为**：测试间有「上一个测试的 entry 残留」可能性——实际靠 `clearInFlight` 删 Map 引用后等 GC。

**理想架构**：
- WeakMap 改成 Map，提供显式 `clearSummaryTextCache` 测试 API
- 或：把 entries 改为 factory 注入而非模块单例

**为什么未在本轮做**：无观察到测试串扰；属过早改造。

**修复后改变**：测试 100% 隔离，无 GC 时序依赖。

---

## DI-14

### message-mapping 100-prefix 字符串匹配 false-positive

**位置**：`src/lib/anthropic/message-mapping.ts:15-37`

**根因**：用「内容前 100 字符」做 fingerprint 匹配。对于 prefix 完全相同的消息（如「Continue from where you left off.」常见自动续接），可能 false-positive 匹配到错误的源消息。

**当前行为**：仅用于 mapping 重建，错误时 fallback `-1`（不 mapping），不导致请求失败。

**理想架构**：用 hash（SHA1 prefix）或完整字符串比对。

**为什么未在本轮做**：无错误触发；fallback 路径安全。

**修复后改变**：消息映射重建 100% 准确。

---

## 总结

14 个 deferred items，分布：
- **架构改进**（DI-1/3/6）：会让本轮一些防御性代码（DEEP_CLONE_FIELDS / structuredClone snapshot）变成不必要
- **测试覆盖**（DI-7/8）：本轮新加功能的回归保护
- **可观测性**（DI-5/9/11）：错误诊断的可追溯性
- **设计一致性**（DI-10/12/14）：边界 case 的策略统一
- **小契约清理**（DI-2/4/13）：文档化或显式化

**重要**：以上所有项都是「真实存在但本轮 scope 外」。**按用户原则，所有项都应在未来某轮认真修复**。本文档不是 backlog 优先级排序，而是供未来决策时的完整上下文。

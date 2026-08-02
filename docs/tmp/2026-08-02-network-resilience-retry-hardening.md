# 网络韧性重试加固（block-level 三腿闭合 + 预算分族 + 总时长预算）

- 状态：**草案 v3 · 两位 reviewer 均判「补完 major 后可定稿」，本版已补完**（2026-08-02）
- v1 → v2：经两轮评审（[GPT 事实核验](2026-08-02-network-resilience-retry-hardening-review-gpt.md)、[Claude 对抗性架构审](2026-08-02-network-resilience-retry-hardening-review-claude.md)，共 4 Blocker / 10 Major / 12 Minor）+ 用户三项裁决全面返工。逐条处置见 [dispositions](2026-08-02-network-resilience-retry-hardening-dispositions.md)。
- 触发：用户诉求「网络波动带来的伤害太大了，需要增强重试机制，增加重试次数默认 9 次，总超时时间到 3600s」+ 三种情形的期望行为。
- 范围：**Anthropic `/v1/messages`（direct + translate 两条腿）+ OpenAI Responses（HTTP + WS）**。Chat Completions / Gemini 出范围，记 backlog。
- 关联：ADR [2026-07-11-block-level-buffered-retry](../decisions/2026-07-11-block-level-buffered-retry.md)、ADR [2026-07-22-continuation-retry-sequential-anchor](../decisions/2026-07-22-continuation-retry-sequential-anchor.md)、spec [inter-block-keepalive-carrier](../spec/2026-07-27-inter-block-keepalive-carrier.md)（阶段 0 权威）。

## 1. 用户期望

| # | 情形 | 期望行为 |
|---|---|---|
| 1 | 尚未 commit block | 无缝重试，客户端无感 |
| 2 | 已 commit block，前缀含完整可交互 tool_use | 静默结束本轮，等客户端回馈（它拿工具去执行并自己接续） |
| 3 | 已 commit block，前缀无 tool_use | 补合成 user 轮续写，缝进同一条客户端流 |

预算诉求：重试次数默认 **9**、总超时 **3600s**。

> **v1 的核心错误**：把这三种情形当成完整的分类轴。实际代码的判别轴是 **error class × commit state × retreat × 预算**四维，三情形只是其中一个投影。v1 的 3 条 Blocker 与 3 条 Major 全部由这个投影损失产生。§4.1 补上四维表，三情形降级为该表的**读者视图**。

## 2. 现状（可核验断言；v2 已按两轮评审逐条修正）

### 2.1 三腿现状

- **C1**（确证）三条腿全挂在 `runResponseBufferedSink` 上；Anthropic 开关 `protectStreamingGeneration` 内置默认 `false`（`state-defaults.ts:124`），shipped `config.yaml:771` 亦为 `false`，用户 override（`~/.local/share/copilot-api/config.yaml`）未覆盖该键 → 走 live 分支（`messages/handler-v4.ts:1367`）→ **情形 1/2/3 对 Claude Code 一条都不生效**。
- **C2**（确证）情形 2 今天与 ADR 不符：`driver.ts:1544` 落 `partial-degrade` → `messages/handler-v4.ts:1388-1416` 给客户端写 `event: error`；ADR D3 明写「不续写，**正常终止**」。
- **C3**（确证）续写腿只有 Anthropic 接线（ledger + extractor + continuation 三件套，`messages/handler-v4.ts:1328-1340`）；Responses 侧三件套全无 → driver 续写分支对 Responses 恒 inert。
- **C4**（确证 + 修正）Responses-HTTP 已块级；WS 故意 terminal-only。**修正**：该分发不在 `ws.ts`，而在 `responses/candidate-response-session.ts:140` 的 `transport === "http"` 门 —— 改动点在此，`ws.ts:372-385` 只是注释说明。

### 2.2 预算现状（v1 此节大面积失实）

- **C5**（修正）内置默认 `bufferedRetryShared.maxRetries: 3`、`maxReactiveRetries: 5`。**v1 错在**「用户 config 亦为 3」：用户 override 无该键，effective 3 来自 shipped config。
- **C13**（新增，v1 完全遗漏）**`max_reactive_retries` 不是网络重试的绑定约束**。两个网络族策略各有内部硬闸，且**低于** 5：
  - `network-retry.ts:35,41,50`：`let hasRetried = false`，`canHandle` 返回 `!hasRetried` → **每候选至多 1 次**；重试延迟是固定 `NETWORK_RETRY_DELAY_MS = 1000`，无退避。
  - `server-error-retry.ts:24`：`const SERVER_ERROR_MAX_RETRIES = 2` 硬编码。
  - driver 的预算门（`driver.ts:589`）在这两个闸**之后**才生效；`canHandle` 返回 false 时走 `recordRetryGiveUp("unclaimed")`（`driver.ts:563-570`），根本到不了预算判定。

  **后果：把 `max_reactive_retries` 抬到 9 是纯空操作，用户头号诉求不会被实现。**
- **C7**（确证 + 补充）`generationMaxTotalCandidates: 5` / `generationMaxTotalDispatches: 16` 是 generation-global lifetime cap，耗尽 `throw`（`generation-budget.ts:45,53`）。**v1 遗漏**：续写分支有 try/catch 降级，**透明重试分支没有**（`driver.ts:1460-1463` 裸 await）→ 预算在透明重试阶段耗尽会异常穿出 driver 到 handler 通用 catch。
- **C8**（收窄）registry 有逐策略唯一 `configKey`（`retry-registry.ts:100-112`），但它是**策略 ID 不是族标签**，schema 只允许 `enabled`。按族解析预算需扩展 entry contract 或加显式映射，**不是零合约改动**。
- **C19**（新增）反应式预算今天**已经是两族**：`driver.ts:589` 的 `action.learning ? learningRetries++ >= maxLearningRetries : normalRetries++ >= maxRetries`，learning 预算 32（`messages/handler-v4.ts:209-210`）。v1 的三档表漏了它。
- **C20**（新增）`generation.recovery.max_candidates: 3`（`config.yaml:979`）是**死旋钮**——写进 state 但 `src/` 无任何读取点。名字恰好像是本设计要调的那个。

### 2.3 总时长预算现状（v1 此条被完全推翻）

- **C6**（**推翻**）v1 断言「仓库不存在任何 per-request 总时长预算」错误。存在**两个**，且用户 live config 里都是 1200s：
  1. `timeouts.request_deadline: 1200`（`config.yaml:261`）—— 精确定时器，`manager.ts:410-424` 在 `create()` 时 arm，到期 `ctx.cancel` + settle。其 config 自述正是「**客户端请求**的最大存活秒数……一次客户端请求可能会被多次内部重试」——**这就是 §4.7 想造的东西**。它已在做「开新腿前检查」语义（`hedge-policy.ts:128` 消费 `runtime-policy.ts:8` 的 `requestDeadlineAtMs`）。
  2. `timeouts.stale_request_max_age: 1200`（`config.yaml:255`）—— 周期扫描 reaper。**命名谎言**：注释写「单次尝试上游最大存活秒数」，实现却是 `manager.ts:306` 的 `ctx.durationMs > maxAgeMs`，按**整个客户端请求**年龄判（`config.yaml:254` 的 TODO 自己指出了这点）。

  **后果：3600s 结构上不可达 —— 两个 1200s 杀手都会先动手。且新增 `retry.total_budget_sec` 会造出第二条平行轨，违反 A2「不留双轨」。**

### 2.4 分类轴与覆盖缺口（v1 全部遗漏）

- **C14**（新增）驱动的两个门额外要求错误属 `"other"` 类：`driver.ts:1430` 与 `:1481`。而 `classifyStreamError`（`packages/foundation/src/stream.ts:164-174`）取值域有 9 个：`idle-timeout / shutdown / client-abort / reaper-cancel / request-deadline / request-cancel / dispatch-cancel / unknown-cancel / other`。

  **后果：`StreamIdleTimeoutError` 无论是否已提交块，既不透明重试也不续写，直接落错误帧。而「上游长时间零帧」正是本仓库文档化的 GHC 主要病理**（`config.yaml:246-249`：「观察到 gpt-5.5 (effort=high) 爆发前有 266–462s 的零帧静默期」）。9 次预算在这个形态下一次都用不上。
- **C15**（新增）buffered 路径**结构性跳过 hedge**：`driver.ts:823-825` `if (outerOpts && "retryCap" in outerOpts) return undefined`，而 Anthropic buffered 分支恒带 `retryCap`（`messages/handler-v4.ts:1344`）。hedge 在用户 config 里是开的，注释自述用途正是「the Claude Code no-real-content watchdog tail」（`config.yaml:968-973`）。
- **C16**（新增）`bufferedBytes` 在块级 commit 后**不清零**：全文件仅 `driver.ts:1227` 初始化 / `:1274` 累加 / `:1275` 判定，块级 commit 只做 `buffer.length = 0`。于是这个「OOM 护栏」度量的是**整条腿累计渲染字节**而非**驻留内存**。且 `retreated` 分支在 `driver.ts:1375-1385` **短路 return，排在三腿之前** → 一旦 retreat，三腿全部不可达。
- **C17**（新增）`liveReconcilingSink` 有**第二个消费者**：`messages/handler-v4.ts:1665` 的 translate leg（`/v1/messages` 打到 `@cc`/`@responses` 模型）。该 leg **结构上不能 buffered**（代码自述 `:1640-1646`：`sawMessageStop` 读的 Anthropic 终止符由 `flushResponse` 在渲染循环**之后**合成）→ 它在范围内却是**零条腿**。
- **C18**（新增，v2-r2 收窄）**两份 ADR 对 Responses-WS 的规范结论直接冲突**：ADR `2026-07-11-block-level-buffered-retry.md:30,34` 说 terminal-only 且「这个非对称是**正确性要求**，不是妥协」；ADR `2026-07-22-…:51-55` D4 说「Responses WS 升块级」。后者较新，且其 `:6` 已声明「修订：2026-07-11…（前 spec）在 Anthropic 上未完成的部分」——**是笼统修订关系，但旧 ADR 的 Responses-WS 条目未标注被 D4 取代，仍保留相反的 Accepted 规范文本**。

### 2.5 客户端保活边界（v1 数据过期 + 覆盖面高估）

- **C10**（修正）300s event-idle 与「ping 不重置、任意非-ping 事件重置」在 CC 2.1.207 源码中成立。但 **byte-idle 不是 60s**：first-party 默认 180s、其他路径基准 300s，可被 `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` / remote setting 覆盖，clamp 10s–1800s。v1 的 60s 是旧版本实测值。
- **C21**（新增，承重）**当前 content 升级被限死在 pre-content**：`delivery/session.ts:126-129` 的 `semanticBlockCount === 0` 门，注释自述「After the first committed block, a no-open window needs the future monotone index allocator」。旧 sink 同门（`client-sink.ts:429`）。

  **后果：块级下首块提交后的长静默，客户端轨上无 open block，只能发裸 ping，撞 300s watchdog 必断。** 本设计三条腿全部作用在 post-content，所以 v1 那条「保活撑得住」的承重因果链**在主战场上是断的**。
- **C22**（新增）该缺口是**已冻结的硬前置门**，不是敞口：
  - ADR `2026-07-22-…:27`（2026-07-27 修订）：「完整覆盖依赖独立方案 A（generation-scoped 单调 wire-index allocator），**并是 Anthropic 块级默认翻转的硬前置门**」
  - spec `2026-07-27-inter-block-keepalive-carrier.md:16,157,193`：三处同义，`:193` 作「**硬门**：A 必须在 Anthropic 块级 buffered 默认翻转前落地」
  - plan `2026-07-27-inter-block-anchor-allocator/`：9 相位。**master 已落 P0 基线与 P6**（`1bf9bf89` / `a15ea821` / `2e1041e8`）；**P1 / P2 已在分支 `feat/anchor-allocator-p1p2` 完成待合并**（`035d37c8` / `79551d06`，`git merge-base --is-ancestor 035d37c8 master` 为 false，分支上 README 自述「P0 / P1 / P2 / P6 已完成」）；**P3M / P7 / P8 未完成**。

### 2.6 已闭合的两个原敞口

- **C11**（闭合）`server_tool_use` **不会**被归一成 `tool_use`：accumulator 分开保留两类（`stream-accumulator.ts:28-61`），extractor 只投影 text/tool_use、明确丢弃 server_tool_use（`committed-block-extractor.ts:53-60`），独立 probe 输出 `[]`。**但**守它的测试是假绿：`tests/anthropic/committed-block-extractor.unit.test.ts:50` 名为 `drops non-replayable block types (thinking / server_tool_use)`，fixture 只有 thinking + text，**无一帧 server_tool_use**。
- **C23**（闭合）统一时钟源已存在两个可用起点：`ctx.durationMs`（reaper 在用）与 `requestDeadlineAtMs`（`runtime-policy.ts:8`，hedge 在用）。

### 2.7 出范围端点

- **C12**（修正）Chat Completions 默认缓冲开，**实际挂了** `ccCommitBoundaries`（v1 说「无 commitBoundaries」是错的），只是该谓词对普通内容不形成中途边界、仅把 in-band error 当边界 → 内容递送实质 terminal-only。Gemini 两条 streaming pump 都只走 `runResponseSink`（`gemini/handler-v4.ts:438,638`），纯 live。

## 3. 公理与判据

- **A1 block-level 是交付形状公理**（用户 2026-08-02 裁决）：绝不提供逐 token 流式体验；response-level 仅作实验选项；冲突内容摧毁而非并存。
  - **A1 落地清单按行为扫描，不按名字扫**（v2 修正）：要枚举的是「**把未缓冲帧写给客户端**」或「**绕过块级提交**」的全部路径。`retreated`（C16）与 hedge 跳过（C15）都是事实上的 live 退路，但不叫 live，v1 的按名字扫描漏掉了它们。
- **A2 无向后兼容负担**：破坏性改动是长远正确形状时强制迁移，允许短期报错，**不留双轨**。
- **A3 长远正确 + 完整 > 最小可交付**：不得以 ROI / YAGNI 降级正确重写；暂缓项完整文档化。
- **A4 richest-data-flow**：合成帧必打可辨识标记；后端存储完整。
- **A5 what-decided-is-decided**：已冻结的 ADR / spec 门不重新论证。**v1 违反了这条**（越过 C22 的硬前置门）。

## 4. 设计

### 4.0 阶段划分（用户 2026-08-02 裁决）

| 阶段 | 内容 | 依据 |
|---|---|---|
| **阶段 0（前置）** | allocator 方案 A：`docs/plan/2026-07-27-inter-block-anchor-allocator/` 的 **P1/P2 分支合并 + P3M / P7 / P8** | 用户裁决「先做 allocator 再动本特性」。C22 的硬门 |
| **阶段 1** | 本 spec 全部内容 | 阶段 0 完成后启动 |

**本 spec 不重复阶段 0 的设计** —— 其唯一权威是 [inter-block-keepalive-carrier spec](../spec/2026-07-27-inter-block-keepalive-carrier.md) 与同名 plan 目录。本节只声明依赖与解除条件。

**解除条件**：阶段 0 的 P8 端到端验收通过（含真 CC 首块后 >315s 静默不断流），且 `delivery/session.ts:126-129` 的 `semanticBlockCount === 0` 门被 allocator frontier 取代。

**唯一例外**：§4.6 的硬闸参数化（B2）与阶段 0 **正交** —— 已核实：反应式重试只在 dispatch 开启阶段触发（`dispatch-scheduler.ts:288` 在 `response.error` 上调 `decideRetry`），**不在流中**，因此抬高网络族预算不产生客户端可见的重复内容，也不触碰 allocator / 块级改动面。可在阶段 0 期间独立先行交付，是用户头号诉求的最快落点。

**但它对 §4.7 不正交**：族预算 9 + 指数退避的挂钟时间无上界约束，而 `request_deadline` 硬掐 1200s 仍在（3600s 属 §4.7、在阶段 1）。慢失败形态下（effective `responseHeaderTimeout` 900s）9 次结构上不可达 —— 那就**复制了 C13「名义 N、实际更少」的同一缺陷**，而 B2 的全部卖点正是消灭该缺陷。故 B2 先行时须写明：**有效上限受 `request_deadline` 约束，族预算须带挂钟感知的 admission**。

### 4.1 四维穷尽表（v2 新增，本 spec 的判据核心）

三情形是**用户语言**；代码判据是四维。实现上用穷尽 `Record` 让类型系统逼出全站点（→ 记忆 `methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit`）。

**维度一：error class**（`classifyStreamError` 的 9 个 kind + 无 throw 的干净截断）
**维度二：commit state**（未提交 / 已提交无 tool_use / 已提交有 tool_use）

| error class | 未提交任何块 | 已提交·无 tool_use | 已提交·有 tool_use |
|---|---|---|---|
| `other`（transport-close） | 情形 1 透明重试 | 情形 3 续写 | 情形 2 静默终止 |
| 干净截断（无 throw、无终止符） | 情形 1 透明重试 | 情形 3 续写 | 情形 2 静默终止 |
| **`idle-timeout`**（须满足下方前置谓词） | **情形 1 透明重试**（v2 新增） | **情形 3 续写**（v2 新增） | **情形 2 静默终止**（v2 新增） |
| `idle-timeout` ∧ **已见终止符** | 不救 · 见下 | 不救 · 见下 | 不救 · 见下 |
| `shutdown` | 不救 · 本进程主动决定 | 不救 · 同左 | 不救 · 同左 |
| `client-abort` | 不救 · 客户端已走 | 不救 · 同左 | 不救 · 同左 |
| `reaper-cancel` | 不救 · 本进程主动决定 | 不救 · 同左 | 不救 · 同左 |
| `request-deadline` | 不救 · 总预算已到（§4.7） | **第四态**（§4.5，落法见 §4.7 第 1 条） | 情形 2 静默终止（落法同左） |
| `request-cancel` / `dispatch-cancel` | 不救 · 主动取消 | 不救 · 同左 | 不救 · 同左 |
| `unknown-cancel` | 不救 · provenance 缺失，先补标签再议 | 不救 · 同左 | 不救 · 同左 |

**`idle-timeout` 三格改为可救的理由**：`streamIdleTimeout` 是**代理自己设的**门限，不是上游的终局决定。上游零帧静默恰恰是用户抱怨的主流失败形态（C14 引的 gpt-5.5 266–462s）。不救它 = 9 次预算在主战场一次用不上。

**但必须带前置谓词 `!sawMessageStop() && !sawUpstreamError() && !sawContentlessRefusal()`**（v3 修正，v2 的无条件版本是新引入的缺陷）：`driver.ts:1396` 的终局提交要求 `drained &&(sawMessageStop || sawUpstreamError || sawContentlessRefusal)`。**上游已发 `message_stop` 但连接不关**（h2 未 END_STREAM、WS 天然长活）时 `drained = false` 且 `thrown = idle-timeout`，直落失败分支。无条件救 → 在一条**已完整**的 assistant 轮之后再追加一轮 → 今天只是多发一个 error 帧，改后升级成**静默内容重复**（更难察觉）。「上游 `error` 帧后静默」尤其永不重试 —— 那是上游终局决定，重试 9 次是刷终局拒绝。


**维度三：retreat**（C16）。修 `bufferedBytes` 清零后，retreat 仅在**单块**驻留超 cap 时触发（病态形态）。届时行为改为：按已提交边界正常交付 + 落本表对应格，**不再短路 return error**。

**维度四：预算**。任一格的动作若需开新腿而预算已尽 → 落 §4.5 第四态（已提交）或返回错误（未提交）。

**取证要求**：改 C14 那两个门时，**三条臂**分别写 mutation 测试 —— ① `idle-timeout ∧ 未见终止符 → 救`；② `transport-close → 救`；③ **`idle-timeout ∧ 已见终止符 → 不救`**。不许只测一条（→ 记忆 `methodology-abort-provenance-tag-at-source-not-guess-at-boundary`）。

### 4.2 情形 1 —— 透明重试

`!committedAny` 门已存在（`driver.ts:1430`）。v2 的新增工作只有两项：

1. 门的 error class 条件按 §4.1 放宽到含 `idle-timeout`；
2. 透明重试分支补 try/catch（C7），预算耗尽降级到显式终态 `recovery-budget-exhausted`，**绝不让预算异常穿到 handler 通用 catch** —— 预算耗尽是可预期终局，不是意外崩溃（`never-swallow-errors` 的对偶：也不要把可预期终局伪装成意外崩溃）。

### 4.3 情形 2 —— 静默终止

替换 C2 的 error 帧：

- **Anthropic**：`message_delta{stop_reason:"tool_use", stop_sequence:null, usage:<见下>}` + `message_stop`
- **Responses**：`response.completed`（`output` 含已提交 items）

**独立实证支持**（v1 未引用）：carrier spec §2.2 记录 CC 2.1.207 在 `content_block_stop` 时**立刻** yield 该块并 `addTool → processQueue → executeTool` —— 工具是 **eager per-block 执行**。所以情形 2 发生时**客户端已经在跑那个工具了**，今天发 error 帧等于让一次已执行的工具调用悬空。

**四项必须定死的语义**（v1 全部缺失）：

1. **终态载体与优先级**：新终态由 driver 的 outcome kind 承载（**不靠 acc 反推**），在 handler 顶层与 `settled-abort` / `stream-error` 并列判定，**早于**整条 `complete` 阶梯。理由：它是 driver 主动做的交付决定。若靠 acc 推断，`acc.sawMessageStop` 仍为 false → 落进 `messages/handler-v4.ts:1525` 的截断分支 → 客户端在干净终止符之后**又收到 error 帧**（→ 记忆 `reference-exactly-one-terminal-is-not-exactly-one-complete-terminus`）。与 `unrepairableToolInput` 可能共存，须显式定夺谁赢。
2. **anchor 收口**：新终止符路径必须调 `closeAnchorIfOpen`（同 `driver.ts:1113-1125` / `handler-v4.ts:1400` 既有处理）。
3. **usage 定义**（需新建**跨腿 usage 累加器**，当前不存在——acc 每腿被 `onAttemptReset` 重建）：
   - `output_tokens` = **跨腿累加已交付块对应的 output**（对应客户端真的拿到的内容）
   - `input_tokens` = **只报第一腿的**。续写腿重发整上下文的重复 input 进 History/telemetry，但不进客户端 wire——客户端的 usage 是「这一轮 assistant 消息」的，不是「我们花了多少」
   - 明说这两者与 History 的账不等，并写明理由（presentation vs 记账）
4. **记账口径**：客户端交付 = 干净（presentation），**请求判定 = `fail` + `upstreamSucceeded: false` + 终态标签 `tool-boundary-terminated`**。沿用 contentless refusal 的同构先例（`messages/handler-v4.ts:1483-1494`：「the client receiving a clean synthesized turn is a PRESENTATION policy, not a claim that the turn produced anything」）。

   **理由**：若记成功，`protect_streaming.by_vendor` 成功率、History 失败率、中断计数都会把「网络掐断」记成「正常完成」—— 而本设计的**验收依据**恰恰是「网络中断造成的伤害下降了多少」。把伤害记成成功就再也无法验证本设计是否有效。「对客户端静默」不等于「对 History/telemetry 静默」，v1 把这两件事混成了一件。

### 4.4 情形 3 —— 续写重试

Anthropic 已 landed。**Responses 新增**：注册 continuation builder（`continuation-request-builder.ts` 的 client-format keyed registry，key union 已含 `openai-responses`）+ `extractResponsesCommittedBlocks` + 格式钩子。

**钩子清单（v2 补全）**：`response.created` 去重、`output_item.added` 的 `output_index` remap、块起始判别、**`sequence_number` 跨腿重映射**、**`response.id` 归一**。后两项 v1 遗漏：Responses 每个事件都带单调 `sequence_number`，全仓 `src/` 无任何一处重写它，续写腿上游从头编号 → 客户端在同一条流里看到序号回退。跨事件关联用 `output_index`/`call_id`，**不用 `item.id`**（→ 记忆 `reference-ghc-responses-item-id-reencrypted-per-event`）。

**前置门（不是敞口）**：
- Responses 侧「可交互 tool_use」谓词（`function_call` vs 上游自执行工具）必须先定义，并与 Anthropic 侧提升为**共享不变量 + 守卫测试**（→ 记忆 `feedback-fix-all-comparison-sites`：这类判别谓词几乎总在多处复发）。
- WS 上能否在同一 generation 内再开一次 dispatch —— **无任何现存生产调用点，须先 PoC**（→ 记忆 `methodology-appliesto-matches-but-chain-never-driven`）。
- `sequence_number` 连续性是否真被 Codex/SDK 校验 —— **先跑探针再写进设计**（→ 记忆 `methodology-probe-external-mechanism-before-writing-it-into-design`）。

**§4.3 对本节有实现顺序依赖**：Responses 的 `response.completed` 需要跨腿 `output` 数组，必须先有本节的 ledger。

### 4.5 第四态 —— 已提交 + 无 tool_use + 预算耗尽（用户裁决）

合成 `message_delta{stop_reason:"max_tokens"}` + `message_stop`（Responses 对应 `response.incomplete`）。

**理由**：语义上就是「内容没写完但轮结束了」，Claude Code 对 `max_tokens` 有既定处理路径，仓库已有 max-tokens 终局观测层可复用。客户端保住已提交内容，且**能看出没写完**。

**明确否决 `end_turn`**：那会把「被截断」伪装成「模型说完了」，客户端与用户都无从察觉，双重违反 `never-swallow-errors` 与 A4。

记账口径同 §4.3 第 4 条：交付干净、判定 fail、终态标签独立（`budget-exhausted-truncation`）。

**内部纪律（v3 新增，A4 的直接要求）**：用户裁决的是 **wire 形状**（不重议），但合成的 `max_tokens` 对**我们自己的**观测层必须可辨识。`handler-v4.ts:1564` 的 `isAnthropicMaxTokensTerminal(acc.stopReason)` 按累加器判，派生 `telemetry-dimensions.ts:154` 的 `max_tokens_truncation` 维度。合成值一旦进 acc 就会被记成「上游 max_tokens 截断」：① 污染已 landed 的 max-tokens 续传观测层判据；② 该特性 P1 自动续传落地后，会对**我们自己合成的**终止符发起续写 → 网络已死时的续写循环。

故：**识别只走 driver outcome kind**（与 §4.3 第 1 条同构，不靠 acc 反推），max-tokens 观测层与未来的自动续传层**显式排除 `budget-exhausted-truncation`**，并加守卫测试。

**该态在本设计下变得更常见而非更罕见**：预算 3→9、总预算 3600s，意味着更多请求走到「腿用完但没生成完」。

### 4.6 预算四族 + 硬闸参数化

| 族 | 现状 | 改为 |
|---|---|---|
| 流中断类（透明重试 + 续写共享） | `buffered_retry.max_retries: 3` | **9** |
| 网络类（network-retry / server-error-retry） | **名义 5，实际硬闸 1 / 2**（C13） | **9**（须先参数化硬闸） |
| 协商类（400-class） | 5 | **5**（不变） |
| learning（`effortLearning`） | 32，已是独立预算（C19） | **32 不变**，文档写明它是第四族 |

**B2 是用户头号诉求的唯一有效落点，且与阶段 0 正交**（见 §4.0 例外条款）。实现项：

1. `createNetworkRetryStrategy` 的 `hasRetried` 布尔闸 → 计数 + 上限来自族预算；**并加指数退避**（当前固定 1000ms，9 次 1s 间隔对瞬时抖动有效，对持续断网是无意义风暴）
2. `SERVER_ERROR_MAX_RETRIES` 常量 → 族预算解析
3. `token-refresh` **单列低值**，不进网络族：凭据无效时重刷 9 次是打 auth 端点
4. registry entry contract 扩展族标签（C8：`configKey` 是策略 ID 不是族）
5. **正样本守卫测试**：断言「族预算 = N **且挂钟时间充裕**时，注入 N 次 `network_error` 恰好产生 N 次重试」。**时间条件不可省** —— 否则守卫会在时间被 `request_deadline` 截断时假绿（同 §4.0 例外条款的边界）。没有这个正样本，改完仍无法证明预算真的接上了（→ 记忆 `feedback-pass-null-clean-not-self-validating`）
6. `generation.recovery.max_candidates` 死旋钮（C20）：接线（须 ≥11）或删除，**不许沉默**（`feedback-never-paper-over-smells-warn-loudly`）

**候选/派发预算推导**（v1 只给数字不给推导，且派发数差一个数量级）：

- **候选数**：每次透明重试与每条续写腿各开一个候选。最坏路径 = 首块前用满 9 次透明重试 → 提交一块 → 被掐 → `remainingShared = 0` 但 `continuationCount === 0` 触发 floor 1 → 再开 1 条续写腿。**总计 1（primary）+ 9（recovery）+ 1（floor 续写）= 11**。

  **但 11 只是「不含 hedge 的 sequential 上界」**：§4.9 要消除 `retryCap` 对 hedge 的排斥，而 hedge 会另开候选（`driver.ts:853-856`、`coordinator.ts:156-160`）。统一协调器落地后，候选公式**必须再加 hedge 上限，或证明 hedge 与 recovery 互斥**。在 §4.9 定案前，`generationMaxTotalCandidates` 的取值不得冻结。
- **派发数**：**两个预算是相乘关系，v1 按相加估了**。但 v2 的「单候选最坏 15」同样不准 —— `DispatchReason`（`dispatch-scheduler.ts:39`）有**四个**取值，`rate-limit-retry` 与 `ws-fallback` 都**不在**四族预算内，其中 429 每次被限流都能继续、直到 scheduler/generation 总闸；且普通族今天共享同一个 `normalRetries` 计数器（`driver.ts:589`），不能笼统按独立族相加。

  **结论：总派发预算不应由「族预算之和」推导，而应由 §4.7 的统一 admission 直接约束 —— 那个 seam 必须覆盖全部 dispatch reason，而不只是四族。** 在 admission seam 定案前，`generationMaxTotalDispatches` 的取值同样不得冻结。

### 4.7 总时长预算 —— 扩展既有键，不新增

**v1 的 `retry.total_budget_sec` 作废**（会造第二条平行轨，违 A2）。正确形状是把 3600s 落到既有的 `timeouts.request_deadline` 上：

1. **admission 加在硬掐之前，`request_deadline` 一个键派生两件事**（v3 定案，弃 v2 的 `mode: hard | admission` 枚举）：
   - **admission**（软预算）：开新腿前检查，到点不开新腿、不打断在途。
   - **硬掐**（外层兜底）：保留现状不动。

   **为什么弃 `mode` 枚举**：它的 `admission` 取值会**删掉「每个请求终有上界」这条不变量** —— 一个配置值就能移除一条不变量，是错误的配置形状。两者派生自同一个量，不是二选一。

   **附带必修**：硬掐定时器今天在**同一 tick** 内 `ctx.cancel(...)` 完立刻 `ctx.fail(...)`（`manager.ts:417-423`），handler 观察到 `request-deadline` 时 ctx 已 settled → §4.1 表里 `request-deadline × 已提交` 那两格的合成终止符无处可落（写在 settle 之后 = History entry 已冻结、客户端拿到的终止符不在记录里，违 A4；与既有超时错误路径并存 = 客户端在干净终止符后又收 error 帧，正是 §4.3 第 1 条要避免的形态）。**修法**：硬掐路径拆成「先通知交付层收口（合成终态 + 记账标签）→ 再 settle」。admission 正常工作时这条路径不该被走到，但它必须是对的 —— 兜底路径出错正是最难发现的那类。
2. **`stale_request_max_age` 的名实不符必须解决，但不能靠「改判原键」**（v3 修正 v2 的方案）：request-age 判据今天**只有两处**（`manager.ts:306` 周期 reaper + `:410` 硬掐定时器）。把 reaper 改判为「单次上游尝试年龄」等于交出其中一处；硬掐若又被切成 admission，则 ctx 泄漏（settle 路径 bug）时无人回收。

   **正确形状**：reaper 保持 request-age 判据不动（值随总预算上调到 ≥3600），**per-attempt 另立第二个键**（如 `upstream_attempt_deadline`）。**两个不同的量并存不属于 A2 说的「双轨」** —— A2 禁的是同一个量的两条平行轨（v1 的 `retry.total_budget_sec` 就是），不是禁止建模两个真实存在的不同量。此句必须留在文中，否则实现者会误引 A2 去合并它们。
3. **admission 判据取 `now + 最坏单腿时长 > deadline → 不开新腿`**，而非裸比较 `now > deadline`。否则会出现「第 3595 秒开了一条最长 600s 的新腿」。直接复用 `hedge-policy.ts:128` 的同构 seam。
4. **抽 `admitNewLeg(costEstimate)` 统一 seam**：三处开腿（透明 / 续写 / 反应式）+ hedge 既有 admission + §4.6 的候选/派发 admission，**全部共用一个**。四处各写一遍必然漂移。这也把 C7 的 `throw` 改成 admission 形式（开腿前问「还有额度吗」，而不是开到一半 throw）。
5. per-attempt 超时不变。**注意 v1 引错了值**：`responseHeaderTimeout: 300` / `streamIdleTimeout: 300` 是 hardcoded fallback；shipped 是 600/600，用户 override 后 effective 900/600。本设计不改动它们。

### 4.8 摧毁 live 退路（按行为扫描，A1 落地）

| # | 路径 | 现状 | 改为 |
|---|---|---|---|
| 1 | `anthropic.protect_streaming_generation` | `false`(默认) / `"on"` / `"tool_use_only"` | `anthropic.delivery: "block"`(默认) / `"response"`(实验)；compat 层 warn-once 强制迁移 |
| 2 | `messages/handler-v4.ts:1367` direct leg live 分支 | 默认路径 | 删除 |
| 3 | **translate leg**（`messages/handler-v4.ts:1665`，C17） | 结构上不能 buffered，零条腿 | 块级化，见下 |
| 4 | `openai_responses.buffered_retry: false` 退回 live | 可选 | 删除；`responses/handler-v4.ts:395` live 分支删除 |
| 5 | Responses-WS terminal-only | `candidate-response-session.ts:140` 的 `transport === "http"` 门 | 升块级（改这个门，**不是改 `ws.ts`**） |
| 6 | **`retreated` 退回 live 写透**（C16） | 短路 return，三腿全失效 | `bufferedBytes` 每次边界 flush 后清零（根因修复）；retreat 保留为**单块** OOM 兜底，其后截断走 §4.1 表而非直接 error |
| 7 | **hedge 被 buffered 结构性跳过**（C15） | `driver.ts:825` | 见 §4.9 |

**第 3 行 translate leg**：根因是 `flushResponse` 在 driver 循环外合成终止符（与 Gemini 同根因，见 ADR 2026-07-11 决策 5）。块级化拉进阶段 1；在此之前 `liveReconcilingSink` 保留且 docstring 写明「唯一存活理由」。

**第 5 行的 ADR 冲突（C18）**：D4（较新）已决定「Responses WS 升块级」——**本 spec 不需要新论证，需要补 supersede 记录**并同步两份 ADR。同时必须逐条回应 2026-07-11 原论证的**全部三点**（不只是重试窗口那点，还有「WS 无中途块/anchor 需求」与 close-code 1011 时序），并把 `plan-4-responses-ws.md:95` 锁的三个时序测试列为必须重写的回归项——它们的前提「partial-degrade 在 WS 上结构不可达」会被块级化推翻。

### 4.9 hedge 与 buffered recovery 统一（用户裁决拉 P7-T3 进范围）

把 hedge 与 buffered recovery 合并到一个协调器（原 P7-T3），消除 `driver.ts:825` 的结构性跳过。理由：两套韧性机制各管一半、各持一套预算，本身就是错误形状；§4.7 的 `admitNewLeg` seam 天然是它们的公共底座。

**进入计划阶段前必须先裁定的五项**（v3 新增；少了它们 planner 无法把本节转成 TDD 阶段）：

1. **hedge 合格性语义**：`hedge-policy.ts:118` 的 `semanticContentCommitted → 不合格`，在块级默认开之后语义变成「**首块提交即永久禁 hedge**」。统一后 hedge 是否允许 post-commit？若允许，与已提交前缀如何并存？这是前置决定，不是实现细节。
2. **预算口径重算**：§4.6 的候选上限未计 hedge secondary（`state-defaults.ts:190` 默认 1）；`generationMaxActiveCandidates: 2` 与「恢复腿 + 并行 hedge」的并发上限也需重推。这也是 §4.6 说「取值不得在 §4.9 定案前冻结」的原因。
3. **与阶段 0 allocator 的接缝**：两个候选并发时 wire-index 的预留 / 回收语义（allocator 是 generation-scoped，hedge 天然并发）。
4. **缓冲归属**：`driver.ts:823-825` 短路移除后，buffered 下谁的 buffer 提交给客户端？败者候选已提交的块如何处置？
5. **验收 oracle 与需先跑的 PoC 项**（同 §4.4 前置门体例）。

### 4.10 观测与验收指标

新终态（`tool-boundary-terminated` / `budget-exhausted-truncation` / `recovery-budget-exhausted`）进 telemetry + History 终局枚举 + `ui-v4` 展示 + `docs/DESIGN.md` 活架构表。counters bag 是开放 `Record`，加维度零版本 bump。

**验收指标**（v1 缺失，没有它无法回答「这个特性有没有用」）：改动前后的「客户端收到 error 帧的请求占比」与「三腿各自救回的次数」。这也是 §4.3 记账口径的下游消费者。

**证伪要求**：① 用**真实** `@anthropic-ai/sdk` 消费合成终止符（独立 oracle，不用自家 accumulator 自证）；② 每条腿写 mutation control，并验证 mutation 真的生效（→ 记忆 `methodology-verify-the-mutation-actually-applied`）；③ 情形 2 的验收必须包含真 Claude Code 拿到终止符后**确实发出了 tool_result**；④ 补 C11 的真实 `server_tool_use` fixture，消灭那条假绿测试。

## 5. 自行拍板（用户可否决）

1. 超总预算且**零提交内容**时返回错误（无内容可保时，静默成功是撒谎）。
2. 情形 2 不向客户端插入任何文字提示。**但**「对客户端静默」≠「对 History/telemetry 静默」（§4.3 第 4 条）。
3. Chat Completions / Gemini 出范围，块级化记 `docs/todo/deferred-backlog.md`。
4. §4.8 第 3 行 translate leg 块级化**拉进范围**（A3 完整性；不做则范围内端点仍有零覆盖路径）。
5. §4.8 第 6 行 retreat 保留为单块 OOM 兜底而非彻底摧毁（修清零后近乎不可达，保留兜底的边际成本极低）。

## 6. 敞口（v2 已把 v1 的四个敞口重新分类）

**已闭合**：O1（server_tool_use，见 C11）、O4（统一时钟源，见 C23）。

**升级为前置门**（不是敞口，必须在实施前解决）：
- Responses 可交互 tool_use 谓词（原 O2）
- WS 能否开续写 dispatch（§4.4）
- `sequence_number` 是否被校验（§4.4）
- WS 块级 × fallback 翻译流的组合（`response.output_item.done` 在 CC→Responses 翻译产物上的语义，从未验证；另注意 `ws.ts:386-387` 现状已与 `plan-4-responses-ws.md:48` 记录的 `bufferedConfigured && !viaFallback` 不一致）

**仍开着的敞口**：
- WS 块级化后 close-code 1011 与已提交帧的先后不变量需重新推导
- `ui-v4` 是否对 outcome 做穷尽 switch（若是，加新终态会编译错误——好事；若字符串透传则静默显示未知值）
- 是否存在「持续缓慢吐字节因而永不触发 idle」的病态腿（影响 §4.7 admission 的最坏单腿时长估计）
- 「3600s 长生成必然累计触顶 16 MiB」是推理非实验（累计口径是代码事实，触顶与否依赖真实生成长度）

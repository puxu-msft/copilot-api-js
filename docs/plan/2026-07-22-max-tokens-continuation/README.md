# max_tokens 续传 — 实施计划总览（README）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec:** [`docs/spec/2026-07-22-max-tokens-continuation.md`](../../spec/2026-07-22-max-tokens-continuation.md)（三轮异模型对抗审查 + 第三轮聚焦确认，plan-ready，0 blocker）+ ADR 待建（landing 时挂靠 `2026-07-05-internal-tool-security-posture` + `2026-07-05-richest-data-flow`，见 spec §16.1 doc-sync 待办）。
> **姊妹底座（已 landed master，复用勿重造）：** [`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md`](../../spec/2026-07-22-continuation-retry-and-sequential-anchor.md) + [ADR](../../decisions/2026-07-22-continuation-retry-sequential-anchor.md) + [其 plan](../2026-07-22-continuation-retry-sequential-anchor/)（尤其 `plan-2b-continuation-executor.md` 记录的 wire-index offset / message_start dedup / `continued` verdict 教训——本计划的续写在**成功路径**触发，同一批坑会重演，逐条对照）。冲突以 max_tokens spec 为准。

**Goal：** 三分型（A=text 已闭合 / B=tool_use 悬挂 / B-closed=tool_use 已闭合 / C=thinking-only）识别 `stop_reason=max_tokens` 成功截断；A 类默认 opt-in 续写到自然终止，客户端默认 `transparent` 缝合（藏掉 max_tokens）；后端 history/telemetry 忠实完整记录真实每轮终止（不受客户端可见性策略影响）；B/C 默认透传，PoC 门后可扩展。

**Architecture：** 与姊妹「错误续写」spec **正交但同构**——姊妹处理**错误 throw 路径**的 `!committedAny` 门旁续写；本特性处理**成功路径**（`message_stop`/`response.completed` 已到达）terminal drain **之前**的新截获分支。复用姊妹已 landed 的 `committed-blocks-ledger` / `committed-block-extractor` / `continuation-request-builder` registry / `continued` verdict / `coordinator.runContinuation`，**不重新发明**；本计划新增的是：① 分型判定器（A/B/B-closed/C 穷尽表）② terminal ownership matrix（每 `inbound×outbound×leg` 一格，四要素）③ 成功终止截获分支（新增实现，姊妹机制不覆盖）④ visibility 策略（transparent/passthrough/marker）+ 组合矩阵校验 ⑤ 独立预算 + 双轨可观测性（`perRoundStopReason`/`clientVisibleStopReason`）。

**Tech Stack：** TypeScript / Bun（`bun test`）；测试 = `bun run test:fast`（单元+http 快速档）/ `test:backend`（交付前全后端）；PoC 探针放 `exp/`（沿用 `exp/continuation-shape/` 目录，姊妹 spec 已在此留 G3/G4/G5 PASS 记录，本特性追加 max_tokens 场景探针）；客户端 wire oracle 用真实 `@anthropic-ai/sdk`/`openai` SDK（skill `client-proxy-e2e-testing`）；mock 上游用四点 hook（skill `upstream-hook-mocking`）。

---

## Global Constraints（每任务隐含包含，逐字来自 spec/CLAUDE.md）

- **默认 `enabled:false` → 零行为变更**：`max_tokens_continuation.enabled=false` 时四格式 max_tokens 透传逐字节等价于现状（golden 回归）。这是每个阶段的 R1 式底线，任何 task 若打破它必须先在该 task 明确记录并单独验收。
- **B-closed 不续写（对齐已 landed ADR D3）**：完整 interactive tool_use 是合法轮边界，proxy 不得跨过它续生成（复用姊妹的 `hasCompleteInteractiveToolUse` 判据，**不重新定义**）。
- **thinking 不可作续写前缀**：C 类无 `continue` 选项（`ledger` extractor 已排除 thinking，ADR D3）；C 类唯一非透传路径是 `retry_with_budget`（**重发**，非续写）。
- **visibility × class 组合矩阵是配置校验的强制规则**：`passthrough` + `classes.*:"continue"/"retry_with_budget"` 必须在配置解析期显式拒绝或降级（记 `strategy-prevented-stitch`），绝不静默吞掉用户配置。
- **后端忠实、前端选择性呈现（richest-data-flow 核心应用）**：无论 visibility 策略如何，`perRoundStopReason`（含被抑制的首轮 max_tokens）与 `clientVisibleStopReason`（客户端实际看到的）必须并存记录；缝合隐藏只作用于转发给客户端的 wire，不回写记录层。
- **合成轮必打 `synthetic:"continuation"` 标记**：复用姊妹机制的 provenance 处理（姊妹已记录该标记目前是 backlog 缺口 `docs/todo/2026-07-22-continuation-synthetic-provenance.md`——本计划若先于姊妹落地该 backlog，则顺手一并解决，不重复挖坑；若姊妹先落地，直接复用）。
- **settle/finalize 时序契约必须先定（P1 首要架构项，spec §5.1）**：post-success 续写在 `message_stop` 已到达后启新 exchange，会撞 `whenModelOperationFinalized`/settle-freeze 不变量（skill `persistence-async-invariants` §2、记忆 `settle 冻结 history entry`、`V3 direct-driver async finalize race`）——必须在 P1 Task 1.1 显式决策「推迟 settle 到续写循环真正终止」还是「已 settle entry 的续写补记协议」，写进 plan 冻结契约表，不得隐式假设姊妹机制的 settle 时序直接适用（姊妹是 cut-path，本特性是 success-path，两者 settle 时点不同）。
- **`test:backend` 全绿 + 相关 golden 字节等价 + flaky 连跑 10-25 次**：涉及 wire 时序的测试（terminal 截获、visibility 缝合）连跑确认确定性。
- **执行环境**：隔离 worktree 或 shared-worktree（按主会话编排决定），细粒度 pathspec 提交（conventional commits，无模型署名）。
- **不缩减 spec 范围**：spec 已定 A/B/C 三分型 + 三 visibility 策略 + 独立预算 + PoC 门分档，本计划全覆盖；PoC 门 FAIL 的分型/格式回退透传（登记 backlog），不牺牲其余分型/格式的落地。
- **Gemini 排除（N1，结构不兼容）**：`getContinuationBuilder("gemini")` 天然返回 `undefined`（复用姊妹 registry 的既有排除机制，不新增判断分支）——Gemini 请求走 `classes.*` 判定时因无 builder 自动落回透传，无需专门代码路径，P0/P1/P3 均不触碰 Gemini codec。

## 相位 DAG（terminal ownership matrix 先行，Anthropic direct 独立先跑，CC/Responses/WS 待矩阵 + 各自 PoC 门）

```
G  PoC 门簇（早跑，定可行性）
   ├ 门 D（transparent 缝合被客户端 SDK 接受，含 usage 单调性）—— 承重，P1 依赖
   ├ 门 A（text-only 前缀续写，继承姊妹 spec 门 A 已 PASS，仅补 max_tokens 场景一发）
   ├ 门 B（悬挂 tool_use 丢弃后续写是否发散）—— 高风险，早跑，决定 P2b 范围
   ├ 门 C（thinking retry-with-budget 是否真提升产出 + 签名安全）—— 高风险，早跑，决定 P2c 范围
   └ 门 E（CC toolCallMap / Responses output_item 悬挂判据可靠性）—— 决定 P4 覆盖
   ▼
P0 分型判定器 + per-format terminal 检测 + 观测层（纯识别、零续写、零行为变更，可独立先行）
   ▼
M  terminal ownership matrix（(inbound×outbound×leg) 四要素表，P3 强制前置产出，不可与 P3 并行画）
   ▼
P1 Anthropic direct A 类续写（成功终止截获，新增实现）—— 依赖 M 的 Anthropic 格）
   ▼
P2 visibility 策略 + 组合矩阵校验 + 独立预算 + 双轨可观测性（跨格式共用层）
   ├─P2b B 类扩展（门 B PASS 后）
   └─P2c C 类 retry_with_budget（门 C PASS 后）
   ▼
P3 CC / Responses(HTTP+WS) 接入（依赖 M 对应格 + 各自 PoC 门 E）
   ▼
P4 非流式挂载点 + 收口（N2 backlog 登记 / doc-sync / ADR 定稿）
```

- **M（terminal ownership matrix）是 P3 的强制前置产出**，两 reviewer 均把它定为「plan 首要交付物」——没有它 CC/Responses/WS 的 wire 拦截点无法唯一确定，不能只靠 per-format PoC 蒙混过关。矩阵在 P0 完成分型判定后、P1 实现前必须先画（P1 只需要 Anthropic 一格，可先画这一格开工，但**全表**在 P3 开工前必须完整）。
- **P1、P2 串行**（P2 的 visibility 缝合直接建在 P1 的成功终止截获分支上）。
- **P2b/P2c 互相独立**，可并行（各自门 gate）。
- **P3 三格（CC / Responses HTTP / Responses WS）可并行**（复用 P2 的 visibility/预算层，各自只需按 M 矩阵实现该格的截获点 + builder）。
- **P4 收口必须在所有已启用分型/格式验收后**，且默认值翻转（如果未来决定收紧/放宽 Q3 初始默认）必须在对应门 PASS 之后。

## 冻结契约（单一事实源，跨任务引用；标 `[复用姊妹]` 的不得重新定义，标 `[本特性新增]` 的在对应 task 落地时唯一定稿）

| 符号 | 类型/签名 | 归属 | 备注 |
|---|---|---|---|
| `CommittedBlocksLedger` / `CanonicalBlock` | 姊妹已定义（`src/lib/pipeline/committed-blocks-ledger.ts`） | `[复用姊妹]` | P0 分型判定器直接读 `ledger.snapshot()` 的最后一块类型 + 闭合状态 |
| `hasCompleteInteractiveToolUse` | 姊妹已定义 | `[复用姊妹]` | B-closed 判据直接复用，不重新实现 |
| `ContinuationRequestBuilder` / `registerContinuationBuilder` / `getContinuationBuilder` | 姊妹已定义（`src/lib/pipeline/continuation-request-builder.ts`） | `[复用姊妹]` | A 类续写复用同一 registry；本特性触发点不同（成功终止 vs cut），但 builder 签名不变 |
| `continued` verdict / `coordinator.runContinuation` | 姊妹已 landed（`model-operation-record.ts:246/250`、`coordinator.ts:143-154`） | `[复用姊妹]` | 本特性的 post-success 续写同样是「部分交付 + 续写接续」的语义，复用同一 verdict，不新增第 6 个值 |
| `TruncationClass` | `"text" \| "tool_use" \| "tool_use_closed" \| "thinking"` | `[本特性新增]` | P0 Task 0.1 定稿；对应 spec §5.2 A/B/B-closed/C |
| `TerminalOwnershipEntry` | `{ leg: string; accumulatorSite: string; terminatorConstructor: string; interceptSite: string; finalCompletionOwner: string }` | `[本特性新增]` | M（terminal ownership matrix）task 定稿，每个 `(inbound×outbound×leg)` 一行 |
| `MaxTokensContinuationConfig` | `{ enabled: boolean; max_rounds: number; classes: { text: "continue"\|"passthrough"; tool_use: "passthrough"\|"continue"; thinking: "passthrough"\|"retry_with_budget" }; message: string; visibility: "transparent"\|"passthrough"\|"marker"; thinking_retry_budget: number\|null }` | `[本特性新增]` | P0 Task 0.3 定稿（schema + state 解析），P2 消费 |
| `pipelineInfo.maxTokensContinuation` | `{ truncationClass, roundsAttempted, roundsSucceeded, continuedTokens, perRoundStopReason: string[], clientVisibleStopReason, suppressedMaxTokens: boolean, visibilityMode }` | `[本特性新增]` | P0 Task 0.4 定稿字段形状，P1/P2 填充 |
| `maxTokensTruncation` / `maxTokensContinuation` telemetry counters | `{class}` / `{class,outcome}` + `continuedTokens` sum | `[本特性新增]` | P0 Task 0.5 |

## 参考

- 权威 spec 承重章节：§3（三分型策略）、§4（visibility 契约）、§5（成功路径新分支 + terminal ownership matrix）、§6（独立预算 + 组合矩阵）、§7（per-format 检测）、§9（可观测性）、§10（测试策略）、§11（sequencing）、§12（PoC 门）。
- 姊妹底座 file:line（已 landed master，2026-07-23 复核确认）：`src/lib/pipeline/committed-blocks-ledger.ts`、`src/lib/anthropic/committed-block-extractor.ts`、`src/lib/anthropic/continuation-builder.ts`、`src/lib/pipeline/continuation-request-builder.ts`、`src/lib/pipeline/driver.ts:1279`（ledger 喂养）/`:1300`（recordCommitted）/`:1336`（terminal drain 起点）/`:1401-1453`（cut-path 续写触发，本特性**不复用此触发点**，只复用其内部调用的 builder/coordinator）、`src/lib/pipeline/generation/coordinator.ts:143-154`（`runContinuation`）、`src/lib/context/model-operation-record.ts:246,250`（`continued` verdict）。
- 姊妹 plan 的教训清单（本计划对应 task 会逐条重演风险，务必对照）：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-2b-continuation-executor.md` §10（异模型审）—— C3（offset 数据源必须是 wire 已交付块数非 ledger 长度）、C4（生产接线是独立必需步骤，不可假设）、Important-1（replay vs append 帧变换挂载点须先画清）、Important-2（`retryNextStrategy` 消费点）。
- PoC 先例：`exp/continuation-shape/`（姊妹 spec G3/G4/G5 已 PASS，FINDINGS.md 在此）、`exp/continuation-stitch/`（P-A wire-index offset 门，含 BROKEN 对照样本）。
- 测试骨架：`tests/e2e-client/continuation-sdk.it.test.ts`（姊妹 SDK oracle 先例，本特性可仿写）、`tests/pipeline/continuation-flow.it.test.ts`（driver 级 sequenced-transport 先例）。

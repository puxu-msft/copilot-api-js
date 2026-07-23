# max_tokens 续传 — 实施计划总览（README）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec:** [`docs/spec/2026-07-22-max-tokens-continuation.md`](../../spec/2026-07-22-max-tokens-continuation.md)（三轮异模型对抗审查 + 第三轮聚焦确认，plan-ready，0 blocker）+ ADR 待建（landing 时挂靠 `2026-07-05-internal-tool-security-posture` + `2026-07-05-richest-data-flow`，见 spec §16.1 doc-sync 待办）。
> **姊妹底座（已 landed master，复用勿重造）：** [`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md`](../../spec/2026-07-22-continuation-retry-and-sequential-anchor.md) + [ADR](../../decisions/2026-07-22-continuation-retry-sequential-anchor.md) + [其 plan](../2026-07-22-continuation-retry-sequential-anchor/)（尤其 `plan-2b-continuation-executor.md` 记录的 wire-index offset / message_start dedup / `continued` verdict 教训——本计划的续写在**成功路径**触发，同一批坑会重演，逐条对照）。冲突以 max_tokens spec 为准。
>
> **修订记录（2026-07-23，据 GPT plan-review 1 blocker + 7 major 修订）**：本计划已过第一轮异模型对抗审查（`docs/plan/2026-07-22-max-tokens-continuation/plan-review-gpt.md`），发现 1 个 blocker（分型数据源误用 continuation ledger）+ 7 个 major（组合校验时序、settle 测试拆分、marker 语义矛盾、terminal ownership matrix 只列 4 格漏了 translate/fallback/reverse legs、synthetic provenance 无具名任务、Q5 三方交互无具名任务、Responses accumulator 字段缺口位置错放）。**spec 已同步修订**（`git log` 提交 `647c47f0`），本次 plan 修订逐条闭合，见各文件顶部的"修订记录"标注。

**Goal：** 三分型（A=text 已闭合 / B=tool_use 悬挂 / B-closed=tool_use 已闭合 / C=thinking-only）识别 `stop_reason=max_tokens` 成功截断；A 类默认 opt-in 续写到自然终止，客户端默认 `transparent` 缝合（藏掉 max_tokens）；后端 history/telemetry 忠实完整记录真实每轮终止（不受客户端可见性策略影响）；B/C 默认透传，PoC 门后可扩展。

**Architecture：** 与姊妹「错误续写」spec **正交但同构**——姊妹处理**错误 throw 路径**的 `!committedAny` 门旁续写；本特性处理**成功路径**（`message_stop`/`response.completed` 已到达）terminal drain **之前**的新截获分支。复用姊妹已 landed 的 `continuation-request-builder` registry / `continued` verdict / `coordinator.runContinuation`，**不重新发明**；但**分型判定的数据源不能复用姊妹的 `committed-blocks-ledger`**（该 ledger 只记已提交前缀，丢弃 thinking、无法区分未闭合/悬挂状态——已被审查坐实为 blocker），本特性须建**独立 per-format terminal observer**。本计划新增的是：① 独立 terminal observer + 分型判定器（A/B/B-closed/C 穷尽表）② terminal ownership matrix（**全 leg 枚举**：direct + translate + fallback + reverse + WS，非只 4 个同格式直连格）③ 成功终止截获分支（新增实现，姊妹机制不覆盖）④ visibility 策略（transparent/passthrough/marker，marker 与 transparent 同样抑制终止符，只是多注一个标记）+ 组合矩阵校验（**P1 首个 commit 就消费，非 P2 才补**）⑤ 独立预算 + 双轨可观测性（`perRoundStopReason`/`clientVisibleStopReason`）⑥ synthetic provenance 标记（独立前置任务，非"顺手"）⑦ Q5 三方叠加集成设计（独立前置任务）。

**Tech Stack：** TypeScript / Bun（`bun test`）；测试 = `bun run test:fast`（单元+http 快速档）/ `test:backend`（交付前全后端）；PoC 探针放 `exp/`（沿用 `exp/continuation-shape/` 目录，姊妹 spec 已在此留 G3/G4/G5 PASS 记录，本特性追加 max_tokens 场景探针）；客户端 wire oracle 用真实 `@anthropic-ai/sdk`/`openai` SDK（skill `client-proxy-e2e-testing`）；mock 上游用四点 hook（skill `upstream-hook-mocking`）。

---

## Global Constraints（每任务隐含包含，逐字来自 spec/CLAUDE.md）

- **默认 `enabled:false` → 零行为变更**：`max_tokens_continuation.enabled=false` 时四格式 max_tokens 透传逐字节等价于现状（golden 回归）。这是每个阶段的 R1 式底线，任何 task 若打破它必须先在该 task 明确记录并单独验收。
- **分型数据源是独立 terminal observer，不是 continuation ledger**（P0 blocker 修订，逐字重要）：ledger 只有 `text|tool_use`、丢弃 thinking、只记已提交（已闭合）块，无法支撑 A'/B/B-closed/C 的判定。P0 必须建独立 observer 并接真实 terminal 调用点，`enabled:false` 时的分型 telemetry 才有真实生产路径（非类型槽位）。
- **B-closed 不续写（对齐已 landed ADR D3）**：完整 interactive tool_use 是合法轮边界，proxy 不得跨过它续生成（复用姊妹的 `hasCompleteInteractiveToolUse` 判据，**不重新定义**——注意这个判据仍然作用于 continuation ledger 的语义域，与 P0 的分型 observer 是两回事：observer 判"这次 max_tokens 截断属于哪个分型"，ledger 的 `hasCompleteInteractiveToolUse` 判"已提交前缀是否含完整 tool_use"，本特性在续写触发前需要**两者都查**——分型必须是可续（非 B-closed）**且**已提交前缀本身也不含其它完整 tool_use）。
- **thinking 不可作续写前缀**：C 类无 `continue` 选项（`ledger` extractor 已排除 thinking，ADR D3）；C 类唯一非透传路径是 `retry_with_budget`（**重发**，非续写）。
- **visibility × class 组合矩阵校验必须随 P1 首个可启用 commit 就生效**（非 P2 才补）：`passthrough` + `classes.*:"continue"/"retry_with_budget"` 必须在配置解析期显式拒绝或降级（记 `strategy-prevented-stitch`），绝不静默吞掉用户配置——`resolveEffectiveMaxTokensContinuation` 在 P0 建好，P1 首个消费点直接用它，不存在"P1 落地到 P2 之间用户可配置出协议错误"的窗口期。
- **marker 与 transparent 同样抑制首轮终止符，只是多注一个标记**（不是"不抑制、只追加"）：一旦真实终止符转出，流已合法终止，无法同流续写——`marker` 是 `transparent` 的严格超集（抑制 + 注记），不是独立机制。
- **后端忠实、前端选择性呈现（richest-data-flow 核心应用）**：无论 visibility 策略如何，`perRoundStopReason`（含被抑制的首轮 max_tokens）与 `clientVisibleStopReason`（客户端实际看到的）必须并存记录；缝合隐藏只作用于转发给客户端的 wire，不回写记录层。
- **合成轮必打 `synthetic:"continuation"` 标记（独立前置任务，非顺手）**：见 `plan-provenance-prerequisite.md`——本 planning 期已核实姊妹 backlog 仍未 landed，本特性须独立实现该标记机制（`OperationSyntheticKind` 加值 + `UpstreamRequestLeg.synthetic` 字段 + driver 真实打标 + History V3 投影 + 真实持久化 oracle），`plan-1` Task 1.4 显式依赖其产出。
- **settle/finalize 时序契约必须先定 + 两个独立 oracle 验证（P1 首要架构项，spec §5.1）**：post-success 续写在 `message_stop` 已到达后启新 exchange，会撞 `whenModelOperationFinalized`/settle-freeze 不变量。`plan-1` Task 1.1a（driver-integration：证明内部循环不 return）+ Task 1.1b（handler/in-process：证明 `ctx.complete()` 只在循环真正结束后调用一次、parent verdict=continued/final=committed）**必须分开测试**，不能只用一层 driver 测试就断言 handler 行为（`runResponseBufferedSink` 本身从不调用 `ctx.complete()`，单层测试会产生假绿）。
- **terminal ownership matrix 须覆盖全部运行时可达 leg**（非只 4 个同格式直连格）：从 `router.ts` 的 `decideRouteFromInput` 逐条枚举 `(clientFormat × targetEndpoint)`，标注每格是否走 `runResponseBufferedSink`（可挂载）或 `runResponseSink`（本版本不支持，强制透传）；translate/fallback/reverse legs 必须显式归类，不能只论证 4 个直连格就自称"全表"。
- **Q5 三方叠加须有具名 integration-design task + 生产 oracle**（非泛化的 merged-state review 能替代）：见 `plan-Q5-three-way-overlap.md`——续写 + 顺序 anchor（若开启）+ 重复截断（若已合并 master）三层的 index 账/挂载层次/预算账须画清 + 至少一个三方生产 oracle 验证。
- **`test:backend` 全绿 + 相关 golden 字节等价 + flaky 连跑 10-25 次**：涉及 wire 时序的测试（terminal 截获、visibility 缝合）连跑确认确定性。
- **执行环境**：隔离 worktree 或 shared-worktree（按主会话编排决定），细粒度 pathspec 提交（conventional commits，无模型署名）。
- **不缩减 spec 范围**：spec 已定 A/B/C 三分型 + 三 visibility 策略 + 独立预算 + PoC 门分档，本计划全覆盖；PoC 门 FAIL 的分型/格式回退透传（登记 backlog），不牺牲其余分型/格式的落地。
- **Gemini 排除（N1，结构不兼容）**：Gemini 入站格式的 pump 只调用 `runResponseSink`，从不调用 `runResponseBufferedSink`（M 矩阵已核实），故天然不可挂载，无需专门代码路径，全部 3 个 `gemini×*` 格标「不适用」。
- **Gate B 分型决策须有可重复方法论**（非临场阈值）：固定 prompts/schema/采样参数 + ≥20 样本量 + 可重复的等价 oracle 判据；产出观测分布，是否 opt-in 的阈值裁决权在用户，不在 planner。

## 相位 DAG（terminal ownership matrix 先行，provenance/Q5 前置任务在 M 后 P1 前，Anthropic direct 独立先跑，CC/Responses/WS 待矩阵 + 各自 PoC 门）

```
G  PoC 门簇（早跑，定可行性）
   ├ 门 D（transparent/marker 统一抑制契约被客户端 SDK 接受，含 usage 单调性）—— 承重，P1 依赖
   ├ 门 A（text-only 前缀续写，继承姊妹 spec 门 A 已 PASS，仅补 max_tokens 场景一发）
   ├ 门 B（悬挂 tool_use 丢弃后续写是否发散——方法论冻结版：固定 prompts+schema+≥20 样本+可重复等价 oracle）—— 高风险，早跑，决定 P2.2 范围
   ├ 门 C（thinking retry-with-budget 是否真提升产出 + 签名安全）—— 高风险，早跑，决定 P2.3 范围
   └ 门 E（CC toolCallMap / Responses output_item 悬挂判据可靠性）—— 决定 P3 覆盖
   ▼
P0 独立 terminal observer + 分型判定器 + per-format terminal 检测 + 观测层 + config schema（含组合校验函数）+ 真实生产接线（纯识别、零续写、零行为变更，可独立先行）
   ▼
M  terminal ownership matrix（全 leg 枚举：direct+translate+fallback+reverse+WS，四要素表，P3 强制前置产出）
   ▼
Provenance  synthetic continuation provenance（独立前置任务，`plan-1` Task 1.4 依赖）
Q5          三方叠加集成设计（独立前置任务，续写×顺序anchor×重复截断）
   ▼（Provenance + Q5 可与 P1 早期 task 并行，但 plan-1 Task 1.4/驱动测试依赖它们的产出）
P1 Anthropic direct A 类续写（成功终止截获，新增实现；组合校验从首个 commit 就生效；settle 时序两个独立 oracle）—— 依赖 M 的 Anthropic 格 + Provenance + 门 D + 门 A
   ▼
P2 marker 策略完整实现（transparent 的严格超集）+ B/C 类门后扩展
   ├─P2.2 B 类扩展（门 B PASS 且用户接受观测分布后）
   └─P2.3 C 类 retry_with_budget（门 C PASS 后）
   ▼
P3 CC / Responses(HTTP+WS) 接入（依赖 M 全部相关格 + 各自 PoC 门 E）
   ▼
P4 非流式挂载点 + 收口（N2 backlog 登记 / doc-sync / ADR 定稿 / merged-state review 以 Q5 时序图为对账标准）
```

- **M（terminal ownership matrix）是 P3 的强制前置产出**，两 reviewer 均把它定为「plan 首要交付物」——矩阵在 P0 完成分型判定后、P1 实现前必须先画 Anthropic 一格开工，但**全 leg 枚举**在 P3 开工前必须完整（含 translate/fallback/reverse/WS，非只 4 个直连格）。
- **Provenance 与 Q5 是独立前置任务，非"顺手项"**——两者在 M 之后即可开工，`plan-1` 的 Task 1.4（History 忠实记录）依赖 Provenance 的产出，`plan-1` 的驱动测试隐含依赖 Q5 已画清的 index 账（防止实现撞见未预料的三方冲突）。
- **P1、P2 串行**（P2 的 marker 缝合直接建在 P1 的成功终止截获 + transparent 抑制机制之上）。
- **P2.2/P2.3 互相独立**，可并行（各自门 gate）。
- **P3 三格（CC / Responses HTTP+fallback / Responses WS）可并行**（复用 P1/P2 的 visibility/预算层，各自只需按 M 矩阵实现该格的截获点 + builder）。
- **P4 收口必须在所有已启用分型/格式验收后**，且默认值翻转（如果未来决定收紧/放宽 Q3 初始默认）必须在对应门 PASS 之后。

## 冻结契约（单一事实源，跨任务引用；标 `[复用姊妹]` 的不得重新定义，标 `[本特性新增]` 的在对应 task 落地时唯一定稿）

| 符号 | 类型/签名 | 归属 | 备注 |
|---|---|---|---|
| `hasCompleteInteractiveToolUse` | 姊妹已定义（`committed-blocks-ledger.ts`） | `[复用姊妹]` | 判"已提交前缀是否含完整 tool_use"，与 P0 的分型 observer 是两个不同判据、须都查（见 Global Constraints） |
| `ContinuationRequestBuilder` / `registerContinuationBuilder` / `getContinuationBuilder` | 姊妹已定义（`src/lib/pipeline/continuation-request-builder.ts`） | `[复用姊妹]` | A 类续写复用同一 registry；本特性触发点不同（成功终止 vs cut），但 builder 签名不变 |
| `continued` verdict / `coordinator.runContinuation` | 姊妹已 landed（`model-operation-record.ts:246/250`、`coordinator.ts:143-154`） | `[复用姊妹]` | 本特性的 post-success 续写同样是「部分交付 + 续写接续」的语义，复用同一 verdict，不新增第 6 个值 |
| `TerminalObserverState` / `createTerminalObserver` / `updateAnthropicTerminalObserver` 等 | `{ lastBlockKind: "text"\|"tool_use"\|"thinking"\|undefined; lastBlockClosed: boolean }` | `[本特性新增]` | P0 Task 0.1 定稿——**独立于 ledger**，是分型判定的唯一合法输入源 |
| `TruncationClass` | `"text" \| "tool_use" \| "tool_use_closed" \| "thinking"` | `[本特性新增]` | P0 Task 0.2 定稿；对应 spec §5.2 A/B/B-closed/C；消费 `TerminalObserverState`，不消费 ledger |
| `TerminalOwnershipEntry` | `{ leg: string; buffered: boolean; accumulatorSite: string; terminatorConstructor: string; interceptSite: string; finalCompletionOwner: string }` | `[本特性新增]` | M（terminal ownership matrix）task 定稿，全 leg 枚举（含 buffered 布尔标注是否可挂载） |
| `MaxTokensContinuationConfig` / `resolveMaxTokensContinuation` / `resolveEffectiveMaxTokensContinuation` | `{ enabled; max_rounds; classes; message; visibility; thinking_retry_budget }` + 组合校验包装函数（返回值含 `diagnostics: string[]`） | `[本特性新增]` | P0 Task 0.4 定稿（schema + state 解析 + 组合校验），P1 首个 commit 就消费 `resolveEffectiveMaxTokensContinuation`（非裸 `resolveMaxTokensContinuation`） |
| `pipelineInfo.maxTokensContinuation` | `{ truncationClass, roundsAttempted, roundsSucceeded, continuedTokens, perRoundStopReason: string[], clientVisibleStopReason, suppressedMaxTokens: boolean, visibilityMode, strategyPreventedStitch?: boolean }` | `[本特性新增]` | P0 Task 0.5 定稿字段形状 + 真实生产接线（三格式 handler 正常 terminal 分支调用），P1 驱动多轮/抑制的真实值 |
| `maxTokensTruncation` / `maxTokensContinuation` telemetry counters | `{class}` / `{class,outcome}` + `continuedTokens` sum | `[本特性新增]` | P0 Task 0.6，消费 Task 0.5 的真实接线数据 |
| `UpstreamRequestLeg.synthetic` / `OperationSyntheticKind += "continuation"` | provenance 标记字段 | `[本特性新增，独立前置任务]` | `plan-provenance-prerequisite.md`，非姊妹既有实现（姊妹仍是 backlog 状态） |

## 参考

- 权威 spec 承重章节：§3（三分型策略）、§4（visibility 契约，含 marker 统一契约）、§5（成功路径新分支 + terminal ownership matrix）、§6（独立预算 + 组合矩阵）、§7（per-format 检测）、§9（可观测性）、§10（测试策略）、§11（sequencing，含 P0 独立 observer 修订）、§12（PoC 门）、§13（Q5 三方交互）。
- 姊妹底座 file:line（已 landed master，2026-07-23 复核确认）：`src/lib/pipeline/continuation-request-builder.ts`、`src/lib/pipeline/driver.ts:1336`（terminal drain 起点，本特性截获点）/`:1401-1453`（cut-path 续写触发，本特性**不复用此触发点**，只复用其内部调用的 builder/coordinator）、`src/lib/pipeline/generation/coordinator.ts:143-154`（`runContinuation`）、`src/lib/context/model-operation-record.ts:246,250`（`continued` verdict）。
- 姊妹 plan 的教训清单（本计划对应 task 会逐条重演风险，务必对照）：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-2b-continuation-executor.md` §10（异模型审）—— C3（offset 数据源必须是 wire 已交付块数非 ledger 长度）、C4（生产接线是独立必需步骤，不可假设）、Important-1（replay vs append 帧变换挂载点须先画清）、Important-2（`retryNextStrategy` 消费点）。
- 本计划自身的第一轮审查报告（须逐条闭合验证）：`docs/plan/2026-07-22-max-tokens-continuation/plan-review-gpt.md`。
- PoC 先例：`exp/continuation-shape/`（姊妹 spec G3/G4/G5 已 PASS，FINDINGS.md 在此）、`exp/continuation-stitch/`（P-A wire-index offset 门，含 BROKEN 对照样本）。
- 测试骨架：`tests/e2e-client/continuation-sdk.it.test.ts`（姊妹 SDK oracle 先例，本特性可仿写）、`tests/pipeline/continuation-flow.it.test.ts`（driver 级 sequenced-transport 先例）。

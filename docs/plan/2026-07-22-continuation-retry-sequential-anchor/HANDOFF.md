# 交接 + 分析:续写重试 + 顺序 anchor（continuation-retry & sequential-anchor）

> 状态：**P2(Anthropic 续写)已完整落地并端到端验证,分支 `feat/continuation-retry`(隔离 worktree,未合并 master)**。日期更新 2026-07-23。
> 权威 spec：[`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md`](../../spec/2026-07-22-continuation-retry-and-sequential-anchor.md)(含实施状态+端点矩阵)+ [ADR](../../decisions/2026-07-22-continuation-retry-sequential-anchor.md)(Accepted)。**P2 落地权威记录见 [plan-2b §11](plan-2b-continuation-executor.md)**。

> **⚠️ 2026-07-23 更新:P2 = Anthropic 续写全链路已 landed**。ADR 经用户裁决(D2 反转:退役空-text 保活→默认 ping+块级顺序输出保 CLI-safety;D3 细化:完整可交互 tool_use 不续写、thinking 发客户端不进合成前缀)。实现:SSOT `continued` verdict → `coordinator.runContinuation` → driver committedAny 旁路缝合分支(wire-index offset + message_start dedup,C3 mutation-verified)→ handler 生产接线 → telemetry 拆分。**真 `@anthropic-ai/sdk` e2e 证缝合流**(含 thinking-offset + chained 多跳)。合并态异模型审 2 Critical + 2 Important 已修(History projection stale-branch 修复、续写预算超候选上限优雅降级、synthetic provenance 缺口记 backlog)。full `test:backend` **exit 0**(先前误判为「预存」的 4 个 History V3 fail 实为 stale-branch bug,已修)。**剩余非 P2**:P3 incident e2e、P4-P6 CC/Responses 续写、P7 默认翻转(依赖 >300s keepalive)、synthetic provenance marker(backlog)。下方 §1-§8 是 P0/P1 阶段的历史交接,保留供追溯。

## 1. 已完成（12 commit，全部行为 oracle 验证过，非仅 typecheck）

| 阶段 | commit | 状态 |
|---|---|---|
| 门簇 G3/G4/G5（真 GHC 计费探针） | `df74a600` | ✅ **全 PASS**（见 §3） |
| G2（300s 死线，长-idle 真 CLI） | `bd89da6f` | ❌ **FAIL → 剥离为独立任务**（见 §4） |
| P0 committed-blocks-ledger | `3e8b8fe0` | ✅ 3 test |
| P0 continuation-request-builder registry | `c2763420` | ✅ 2 test |
| P0 config `buffered_retry.continuation` | `a440157c` | ✅ 6+4 test，守卫完整性 + 全 apply-path 覆盖 |
| P0 `continuation-exhausted` outcome + telemetry 双计数 | `e2a1e9d5` | ✅ 6 test，6 文件 literal 更新 |
| P1 allocator 原语 | `13211ca3` | ✅ 3 test（**未接线**，见 §5） |
| **P1 顺序 anchor（承重①）** | `266a6f5f` | ✅ **完成+验证**：50 anchor 测试 + 真 CLI e2e numTurns=1 + 4432 test:fast 绿 |

**基线**：master 起点 4429 test:fast pass；分支 4432 pass 0 fail。P0 纯新增、P1 对非-anchor vendor 惰性。

## 2. 承重模型修正（下一会话务必先读——我两度修正了心智模型）

**coexist「anchor@0 全程 open 跨真实块」不是通用行为，精确是 BUFFERED 路径行为**：
- **LIVE 路径**（`live-reconcile.ts:125-142`）本就顺序化：首个真实 `content_block_start`/终止前关 anchor + 真实块 remap+1。
- **BUFFERED 路径**（`driver.ts` flushBufferedFrames）此前保持 anchor@0 全程 open = **CLI-unsafe 的 coexist**。

**P1 的修复 = buffered flush + retreat 两路径 close-before-first-real-content_block_start**（对齐 live 路径）。单个 pre-content anchor → offset 恒 +1，故 **allocator（Task 1.1）未被使用**——它是为「gap 多 anchor」设计，而 gap 保活载体归入剥离的 keepalive 任务。P1 的 CLI-safety 不依赖 allocator。**若未来 keepalive 任务选「gap 多 anchor」方案再接线 allocator。**

**验证 oracle**：`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 的 (b)/(c) 已改写为顺序断言 + **`maxOpen===1` CLI-safety 不变量**（永久回归测试，比 exp 脚本好）。真 CLI e2e = `exp/block-level-anchor-sequential/run.ts`。

## 3. 门簇结果（全 PASS，简化了 spec 的多个 fallback）

`exp/continuation-shape/FINDINGS.md`：
- **G3** Anthropic 接受「完整 tool_use 块作 assistant 前缀 + user 续写轮」→ 续写覆盖 tool_use 前缀，不限 incident 的 text-only。
- **G4** CC 并行 tool_call **严格按 index 串行**到达 → CC 可升块级，index 跳变边界判据成立。
- **G5a** GHC **不强制** OpenAI tool_calls 尾随约束 → CC 续写无 hazard，spec §4.3 窄场景 fallback **不需要**。
- **G5b** Responses 接受 prior-output 续写 → Responses（HTTP/WS）续写可行。

## 4. G2 = FAIL，已剥离为独立任务（**可能是现网 keepalive 回归**）

见 [`docs/todo/2026-07-22-client-proxy-keepalive-300s.md`](../../todo/2026-07-22-client-proxy-keepalive-300s.md)（master `c14da196`，含提示词）。
- 顺序 anchor gap 的**空 text_delta 未能重置 claude 300s 死线**（经代理路径，302s stall）。
- **裁决翻转**：first-party 路径上空 text_delta 和 thinking_delta **都能**重置（两 arm 各 341s 存活）→ 根因是**路径**（first-party vs 经代理），非 delta 类型、非 CC 版本。`Response stalled mid-stream` 是 claude 自己的报文（不在代理 src）。
- **对 incident 无影响**（142.9s < 300s，续写主线不阻断）。仅 >300s 上游静默受影响。

## 5. 下一步：P2 续写 driver 分支（承重②，reviewer Critical-2）—— 精确接入点已勘定

`plan-2-continuation-driver.md` + 我读码勘定的接入点：
- **ledger 喂养**：`driver.ts:1227`（`committedAny = true` 处）把刚提交的块**组装成 CanonicalBlock 喂 ledger**。⚠ **难点**：buffer 里是 content_block_start/delta/stop 帧，须**累积 deltas** 还原成 text 内容 / tool_use name+input——查 codec 是否已有 response accumulator 可复用（`createResponseAccumulator`），别重造。
- **committedAny 旁路续写分支**：`driver.ts:1299` `const retryable = (...) && !committedAny` 这个硬门旁**加平行分支**：`committedAny && continuation.enabled && getContinuationBuilder(fmt) && 预算未耗 → runContinuation(...)`（append 语义，非 buffer-replay）。terminal-only 路径 committedAny 恒 false、逐字不变（R1）。
- **continuation-executor**（新）：用 `getContinuationBuilder(fmt)(originalEnv, ledger.snapshot(), resolveContinuation(vendor).message)` 构造上游续写请求（原始 body + assistant=已提交块 + 合成 user 轮），跑**新 exchange**（新 candidate，非 `coordinator.runRecovery` 同-candidate），输出帧**接同一 sink**、index 接续（单 anchor 已关，续写块从当前 index 续）。合成轮打 `synthetic:"continuation"`、进 upstreamRequest 轨不污染上游原始轨。
- **共享预算保底 1 次**（spec §5.2）：`max(remainingShared, continuationFloor=1)`，防首块前重试饿死续写。telemetry 传 `meta.continuationRetries` 拆计数（P0 已备）。
- **generation 候选语义**：`selectGenerationWinner`/`bind` 假设 recovery=同 candidate；续写是「逻辑延续的新 candidate」，须显式论证不破坏 hedged winner 选择。

**验证**：driver 级 `.it` + 真实 `@anthropic-ai/sdk`/`openai` SDK oracle 消费缝合流（skill `client-proxy-e2e-testing`）+ incident 复现 e2e（plan-3 Task 3.3）。

## 6. 之后：P3-P7（各自门已 PASS，fallback 大多不需要）

- P3 Anthropic 续写（builder + SDK oracle + incident 复现）—— **主目标验收**。
- P4 Responses HTTP / P5 CC 升块级+续写（G4 串行已证，用 index 跳变边界）/ P6 Responses WS 升块级+续写（WS 传输门）。
- P7 退役 whole + 默认翻转（**G1/G2 相关：Anthropic 块级默认 on 须先解决 >300s keepalive 或接受 <300s 限制**）+ doc-sync（DESIGN 活架构现状、streaming.md）+ ADR 定稿 + 合并态审查 + FF 合并 master。

## 7. 收尾状态（session-closeout 五步）

- ① subagent audit：**未做**——P1 是行为-oracle 验证（50 测试 + 真 CLI），下一会话进 P2 前建议对 P1 merged-state 派异模型审。
- ② doc-sync：**未做**（特性未合并 master，DESIGN 回填是 P7 步；本 HANDOFF + plan 已同步分支内状态）。
- ③ 归档 plan：plan 已在 `docs/plan/`（分支内），无 `~/.claude/plans` 待迁。
- ④ 记忆：见 MEMORY 新增 stub（指向本 HANDOFF）。
- ⑤ 提交：全部细粒度 pathspec 提交、worktree 干净。

## 8. 续接 kickoff（复制给新会话）

> 接续 `feat/continuation-retry` 分支（worktree `.worktrees/continuation-retry`）的续写重试特性。**先读** `docs/plan/2026-07-22-continuation-retry-sequential-anchor/HANDOFF.md`（本文件，含承重模型修正 + 精确接入点 + 门结果）+ 权威 spec。P0+P1 已完成验证（12 commit）。下一步 P2 续写 driver 分支：ledger 喂养（`driver.ts:1227`，复用 codec accumulator 组装 CanonicalBlock）→ committedAny 旁路续写分支（`driver.ts:1299` 硬门旁加）→ continuation-executor（append 新 exchange 接同一 sink）→ generation 候选语义。共享预算保底 1 次。用真实 SDK oracle 验缝合流。门 G3/G4/G5 全 PASS（fallback 大多不需要）。>300s keepalive 是独立任务（`docs/todo/2026-07-22-client-proxy-keepalive-300s.md`），别牵扯。裁决实测 > 文档 > 声称，协议关键改动 typecheck 绿 ≠ 协议对、须行为 oracle。进 P2 前对 P1 merged-state 派异模型审。

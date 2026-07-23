# Kickoff: max_tokens 续传（max-tokens continuation）实施

复制以下内容开新会话启动实施。

---

你要实施「`max_tokens` 续传」特性。**先读**（按序）：

1. 权威 spec：`docs/spec/2026-07-22-max-tokens-continuation.md`（什么/为何，单一事实源，已三轮异模型对抗审查 + 第三轮聚焦确认，plan-ready，0 blocker）。
2. 计划总览：`docs/plan/2026-07-22-max-tokens-continuation/README.md`（DAG + 冻结契约 + Global Constraints）。
3. 姊妹底座 spec + ADR（本特性复用其机制、触发路径不同）：`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md` + `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md`（ADR D3：完整 interactive tool_use 不续、thinking 不作前缀——**硬约束勿违**）。
4. 姊妹计划的教训清单（本特性会重演类似风险，务必对照）：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-2b-continuation-executor.md` §10（C3 offset 数据源、C4 生产接线、Important-1 帧变换挂载点、Important-2 retryNextStrategy 消费）。

**执行环境**（项目 CLAUDE.md concurrent-sessions + protect-user-main-server，由主会话决定 worktree 隔离方式）：
- **绝不碰 4141**；测试服务器起非-4141、按 PID 精确清理。不跑 `bun run start/dev`。
- 细粒度 pathspec 提交（`git commit -- <精确路径>`，conventional commits，无模型署名）。

**实施顺序（gate-first + matrix-first）：**
1. **先跑门簇** `plan-G-gates.md`（门 A/B/C/D/E）。**门 D（transparent 缝合被 SDK 接受）是 P1 的硬依赖，必须先过**；门 B/C 是高风险早跑项，决定 P2b/P2c 是否落地；门 E 决定 P3 CC/Responses 的 B 类覆盖范围。
2. `plan-0-classifier-and-observability.md`（分型判定器 + 观测层，纯识别零续写，可独立先行、甚至可与门簇并行）。
3. `plan-M-terminal-ownership-matrix.md`（**两轮异模型审查共同点名的首要交付物**——Anthropic 格已在 planning 期确认可直接用；CC/Responses(HTTP)/Responses(WS) 三格标注为「待核实」，**P3 开工前必须补全**，Task M.1）。
4. `plan-1-anthropic-continuation.md`（Anthropic direct A 类续写，依赖 P0 + M-Anthropic格 + 门 D + 门 A）——**Task 1.1 的 settle/finalize 时序决策必须先做**，这是 spec §5.1 标注的承重架构项，不是可以跳过的核实项。
5. `plan-2-visibility-and-budget.md`（visibility 策略 + 组合矩阵校验，依赖 P1）。
6. `plan-3-cc-responses.md`（CC/Responses HTTP/WS 接入，依赖 M 矩阵三格补全 + 各自门）。
7. `plan-4-closeout.md`（非流式 backlog 登记 + doc-sync + ADR + merged-state 审查 + 收尾）。

**方法（`superpowers:subagent-driven-development` 推荐）：** 每 task 独立 subagent + 两阶段审查（no-self-review）；异模型 reviewer 审 Claude 产出，prompt 显式写裁判轴（长远正确 + 完整，非 ROI/YAGNI）。TDD 逐 task；每 task 末显式 pathspec commit。

**承重纪律（务必守）：**
- **不缩减 spec 范围**：A/B/C 三分型 + 三 visibility 策略 + 独立预算 + PoC 门分档全覆盖；门 FAIL 的分型/格式回退透传 + 登记 backlog，不静默砍需求。
- **不重复发明姊妹机制**：`CommittedBlocksLedger`/`extractAnthropicCommittedBlocks`/`hasCompleteInteractiveToolUse`/`ContinuationRequestBuilder` registry/`continued` verdict/`coordinator.runContinuation` 全部复用，本特性只新增触发点（成功路径截获）+ 分型判定 + visibility 策略层。
- **触发点是成功路径，不是错误路径**：`driver.ts:1401-1453`（姊妹 cut-path）与本特性的截获点（`driver.ts:1336` 附近的 terminal drain 分支）是**互斥的不同代码路径**，不可混淆或试图复用同一个 `canContinue` 判据。
- **B-closed 恒不续写**（ADR D3，完整 interactive tool_use 是合法轮边界）；**thinking 无 `continue` 选项**（只有 `retry_with_budget` 重发，非续写）。
- **visibility×class 组合矩阵是强制配置校验**：`passthrough` + `continue`/`retry_with_budget` 必须显式拒绝/降级 + 记 `strategy-prevented-stitch`，绝不静默吞配置。
- **后端忠实、前端选择性呈现**：`perRoundStopReason`/`clientVisibleStopReason` 必须并存，用独立 history oracle（真实持久化读回，非手动 round-trip）验收，不接受"客户端看起来对就行"的自证。
- **默认 `enabled:false` → 零行为变更**：每个阶段的 R1 式底线，golden 字节等价验证。
- **wire 正确性用真实 SDK oracle**（`@anthropic-ai/sdk`/`openai` 官方 SDK，非仅宽容的 `@ai-sdk`）；flaky/时序连跑 10-25 次；裁决实测 > 文档 > 声称。

**主目标验收：** Anthropic direct A 类续写 opt-in 后，客户端看到干净的 `end_turn`（transparent 默认），后端 history 完整记录真实每轮终止 + 合成轮 provenance；`enabled:false` 时零行为变更（golden 回归验证）。

# Plan-5: 收口 —— doc-sync + backlog 复核 + 默认值翻转时机

> **依赖：** Plan-1（B1）+ Plan-3（B2 全阶段）+ Plan-4（B3）均已落地并各自通过 `bun run test:backend`。

## Task 6.1：doc-sync

- [ ] `docs/DESIGN.md`「活的架构现状」：新增/更新 delayed-commit 一节，说明"commit 后失去内部恢复能力"这一历史缺陷已被 B2 消解，标注三层防线（B1 窗口/B2 主线/B3 逃生舱）现状。
- [ ] `docs/spec/2026-07-23-upstream-silence-commit-timing.md`：本 spec 状态从"草案"改为"已落地"（或"部分落地"，视 Q1/Q2 实测是否已完成），补充实施结果小节（链接本 plan 目录 + 实测 Q1/Q2 结果，若已获得）。
- [ ] `docs/decisions/`：本次是否需要新增 ADR？**判断依据**：B2 的"pre-ready failure ownership + 统一 semantic-content gate + sink lifetime supervisor"三件新机件构成了一个新的架构模式（"post-commit pre-content 恢复"），比"实现细节"更接近"架构决策"——建议新增 ADR `docs/decisions/2026-07-23-upstream-silence-recovery-three-tier.md`，记录：为什么放弃"判别 A/B"转而"消解判别"、为什么 B2 不是 continuation 变体、为什么 B5（并发赌）不作主线。**这是本计划建议但不代替用户/主会话决定是否要写 ADR**——若认为实现细节层面的决策不足以升格为 ADR，可以只在 spec 状态更新里补充"已落地"标注，不强制新增 ADR 文件。
- [ ] `docs/API.md`：若 B3 新增了一个可观测的 SSE error type（如 `overloaded_error` 的新触发原因），在端点备注里补充一句说明。
- [ ] `docs/todo/deferred-backlog.md`：登记本计划范围内识别出但未纳入的项（见下方"识别出的 backlog"）。

## Task 6.2：默认值翻转时机（硬性顺序，不得违反）

- [ ] **B1 的默认窗口值调整（Plan-1 Task 1.2）必须在 Q1 实测完成后才提交。**
- [ ] **B2 的 `precontent_recovery.enabled` 默认值虽在 Plan-2 Task 0.1 就写成 `true`，但必须在 Plan-3 全部阶段（P4-P6）落地、协议矩阵全绿后，这个默认值才能对生产流量产生实际影响**——即：Plan-2 提交时的"默认 true"只是配置骨架的占位值，真正让它在请求路径上生效的是 Plan-3 的接线（`handler-v4.ts` 读取这个配置）。**不要**在 Plan-3 尚未完成时就让默认值在生产语义上"生效"（体现为：Plan-2 阶段的测试只验证配置本身读写正确，不验证任何请求路径行为变化；行为变化只在 Plan-3 完成后的测试里出现）。
- [ ] **B3 的默认上限值（~300s）已经是最终值**（spec Q6 已裁决），落地即生效，无需分阶段。

## Task 6.3：识别出的 backlog（不静默砍，记录 + 说明为何暂缓）

以下是本计划撰写过程中识别出、但**明确超出当前三层防线范围**、长远该做但不阻塞本计划验收的项 —— 按项目哲学（`no-silently-cut-but-defer`）登记，不擅自砍：

1. **B5（pre-header 并发赌）** —— spec/FINDINGS 已明确列为独立备选，PoC 已确认可行但需要新的 pending-open race 拓扑（不同于 B2 的串行救援）。**暂缓原因**：B2 已经是长远正确的主线，B5 是"进一步优化尾延迟"的加分项，不是 gating 需求；且 B5 引入"双份上游成本"的显式取舍，需要用户单独确认是否接受这个成本。**触发条件**：B2 落地并观测一段时间后，若"救援本身增加的延迟"（一次完整的 fresh dispatch 往返）成为新的用户痛点，再评估 B5。

2. **Q3（Responses/gpt 路径的 header 时序是否也是 deferred-header）** —— spec 明确"这是另一个 spec 的事，不混入本 Anthropic spec"。**暂缓原因**：范围边界已由 spec 划定，本计划遵循。**触发条件**：Responses 路径出现类似 req_57/58/63 的事故形态时，需要独立走一遍"实测 header 时序→是否需要类似 B1/B2/B3"的流程。

3. **Q8（GHC pre-content capability probe，独立状态面）** —— spec 明确"即便最终不采用作判别，也记录探测结果+排除理由"。**暂缓原因**：本计划的 B2 设计不依赖这个探测结果（"消解判别"而非"依赖更好的判别信号"），所以 probe 本身不是 gating 项，但仍有诊断价值。**若做需改什么**：需要真实 GHC 环境做只读探测（job/status API、关联 ID、HTTP/2 informational response 等），记录进 `exp/` 或 skill。

4. **Q7 的"统一覆盖 live/delayed-commit/buffered 三路径"设计上的完整落地** —— 本计划（Plan-3）的 splice 执行器设计上复用了 `reconcileLiveFrame`（live 路径的既有机件），理论上对 buffered 路径也该有对应的处理，但**本计划的 TDD 步骤只针对 delayed-commit（COMMIT 分支）这条事故路径实现**，buffered 模式下"pre-content 失败后 fresh recovery"的完整实现留待后续。**暂缓原因**：against-YAGNI 的"设计上统一、执行上分阶段"精神——`hasDeliveredSemanticContent`/`shouldAttemptPreContentRecovery` 等纯函数是格式/路径无关的，为 buffered 路径的后续扩展打好了基础，但 buffered 路径本身有自己的 commit-boundary/retry-cap 机制（`resolveBufferedCaps`），需要额外设计"B2 恢复与既有 buffered-retry 的预算如何共享"这个问题——不在本计划范围内草率决定。**若做需改什么**：需要新 spec/plan 明确 buffered 路径下 B2 与既有 `bufferedRetryShared.maxRetries` 预算的关系（是共享同一个 cap，还是独立预算）。

5. **`reaper-cancel`/`timeout` 是否纳入 B2 触发范围**（Plan-3 Task 4.3 已列为门控问题）——本计划默认排除，但标注为"可扩展、需用户确认"的边界，不是永久排除。

6. **B3 的触发原因遥测细分**（Plan-4 Task 5.3 只做了最基础的计数器）——是否需要按"B2 从未触发就直接到 B3"vs"B2 触发过但失败才到 B3"这两种路径分别计数，本计划只做了后者的基础版本，细分维度留待运维实际需求出现后再加（镜像 `docs/todo/deferred-backlog.md` 里"retry-fire counter 无维度切面"那条的暂缓理由——先有粗粒度视图，细分待真实需求）。

## Task 6.4：会话收尾（session-closeout skill 对应项）

- [ ] Subagent audit：完成实施后，派 `reviewer`（对抗审查）复核合并态——尤其 Plan-3 Task 4.3 的 handler 接线（sink 生命周期）与 Plan-2 Task 0.3 的 coordinator 新方法（budget/settle 语义）。
- [ ] doc-sync + 跨文档 grep 验证（本 Task 6.1 已列）。
- [ ] 归档 plan：本计划完成后，在本 README.md 头部加"实施状态：已完成/部分完成"标注。
- [ ] 提炼教训：若实施期发现本计划的某个设计假设（尤其 `reconcileLiveFrame` 复用的可行性、`selectGenerationWinner`/`active` 变量的边界情况）与实测不符，写入 memory / skill，供后续类似"post-commit 恢复"场景参考。
- [ ] 细粒度阶段提交：每个 Task 一提交，已在各阶段文档的 TDD 步骤里逐条列出。

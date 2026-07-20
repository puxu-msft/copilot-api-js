# Kick-off：把「反应式上游拒绝协商」RFC 拆成实施计划

## 你是谁、任务是什么

新会话，承接一个**已定稿、已过三轮对抗 review 的 RFC**，任务是把它拆成分阶段实施计划（writing-plans）。**不要重新 brainstorm、不要重新 review RFC 设计**——设计已冻结。你的产物是 plan + kick-off prompts，不是代码。

## 必读（按序）

1. **RFC（唯一事实源，已冻结 v5）**：[docs/rfc/2026-07-07-reactive-upstream-rejection-negotiation.md](../rfc/2026-07-07-reactive-upstream-rejection-negotiation.md)
   —— 问题陈述（8 缺口 A–H 带 file:line 证据）、根因定性（能力框架非 vertex 硬断言）、架构、分 phase cutover、commit invariants、O1–O6 全部已定、验证策略、计数语义附录。
2. 项目工作流与纪律：`~/.claude/rules/00-user/60-feat-dev-workflow.md`、项目 `CLAUDE.md`（长远正确 + 完整 > ROI/YAGNI）。
3. 相关 skill：`large-refactor`（§5 三层文档结构、commit invariants、golden-fixture 预捕获）、`empirical-verification`、`verifying-authoritative-claims`、`telemetry-architecture`、`history-sqlite-schema`、`test-isolation`。

## RFC 已冻结的关键决策（不要动摇）

- **能力框架**：per-model「拒绝 inline system」是**观测症状**、非 vertex 硬断言（学入日志如实写「推断」）。判别轴 = `resolveModelName` 最终 outbound 名。
- **O1** C 用反应式 strategy（`Tool '…' not found in provided tools` → 触发 server-tool-history downgrade → 重试）。
- **O2** `system_reject_models` 默认内置 `[claude-sonnet-4.6, claude-haiku-4.5]`（实测确认）。
- **O3** 本轮做 F（token-limit 变体），**前置**：先捕获真实上游 body 做 golden，再加正则；捕不到就不做（无 golden 不猜）。
- **O4** D/E 补当前已知 feature/tool（非完全数据驱动表）。
- **O5** B 存储用**独立 `effortUnsupported: Set<modelKey>`**（顶层 Array 持久化；supportedEfforts 5 处逻辑不动；碰撞按构造消失）。
- **O6** A 反应式用 **(c) learn `systemRejectModels` → `getResanitize(context.originalPayload)` 重跑 S3 → 重试**。**喂 pre-S3 baseline 是正确性硬约束**（喂 already-S3 的 currentPayload 会 double-apply 整条链）。

## 你要产出什么

按 `large-refactor` §5 + user-rule 60，为这个单 RFC + 分 phase 结构产出：

1. **master plan**：`docs/plan/reactive-upstream-rejection/plan.md`（或按你判断的单文件 `docs/plan/2026-07-…-reactive-upstream-rejection.md`），含每 phase 每 Task 的 **TDD 步骤** + **factory/锚点表**（RFC 里点到的现有函数 file:line：`sanitizeAnthropicMessages`/`sanitizeInlineSystemMessages`/`parseInvalidEffortError`/`clampEffortLevel`/`findSupportedEfforts`/`snapshotEffortMap`/`loadEffortMap`/`getResanitize`/`buildAnthropicStrategies`/`markAnthropicPartnerFeatureUnsupported` 等）+ order 常量。
2. **per-phase kick-off prompts**：`docs/plan/reactive-upstream-rejection/prompts/`（P1–P4 各一 self-contained 文件 + README 导航 + 阶段依赖 DAG + 集中红线）。
   - **DAG**：P1（框架 primitive + A + B）是前置；P2（C）、P3（D/E/F/G）、P4（H）可在 P1 后并行；P3 内部各子项格式独立可并行；F 须 golden-first。

## 分 phase（来自 RFC §4）

- **P1 承重最重**：抽 learn/persist/canHandle primitive（strip 类，A 的 role-rewrite 单列 arm）；A 全套（config schema `system_reject_models`/`system_reject_mode` + `systemRejectModels` negotiation Set + 有效模式在 `sanitizeAnthropicMessages` 内从 `payload.model` 算 + count-tokens **无条件清洗** + 反应式 strategy 用 getResanitize(originalPayload) + meta.sanitization 回传）；B 全套（新 parse 分支 + 独立 `effortUnsupported` 集 + clamp 前置剥除 + persist→reload golden）。
- **P2**：C（web_search-not-found 反应式 strategy）。
- **P3**：D（partner-feature 表驱动，**两处 strip 站点**）/ E（server-tool 表）/ F（token-limit 变体，golden-first）/ G（deferred-tool 双层包裹 raw 回退）。
- **P4**：H（AttemptSnapshot 加 rawBody + per-attempt error body 持久化 + history 投影 surfaced）。

## Commit invariants（写进每 phase plan 的验证步）

- 每 commit 终态 typecheck 绿 + 测试通过 + 无「给要拒的请求白做/重复处理」半破碎态。
- 反应式 strategy 只在其目标 400 上触发、对其他请求零副作用。
- B：persist→reload golden（学入 → snapshot 写盘 → load 重载 → 重准备仍剥除）——否则首次重启回归而测试仍绿。
- A：reject 集模型 outbound 无 system 角色 + 上游 200；非 reject 模型透传（除非全局开）；反应式 mock 首发 400 → 学入 + getResanitize + 重试已清洗。
- 每 strategy 用**正样本证 canHandle 触达目标**（先证正则匹配真实错误串）；wire 正确性用 GHC 独立 oracle（实测，不字节自洽）。

## 纪律红线（集中，各 phase 引用）

- **no-auto-server-no-kill**：不启动服务器、不 kill 本项目实例；可跑 typecheck/lint/bun test。
- **细粒度、显式 pathspec 提交**（`git commit -F <msg> -- <精确路径>`）；conventional commits；无模型署名。
- **subagent-explicit-rubric**：实现后派 subagent code-review，prompt 里写明裁判轴（长远正确+完整、非 ROI）；reviewer 的绝对断言亲自对照代码复核。
- **empirical-verification**：flaky/时序测试连跑 10–25 次；否定/通过/自洽结论不自证。
- **session-closeout**：收尾五步（subagent audit → doc-sync → 归档 plan → 提炼教训 → 细粒度提交）。

## 起手第一步

调用 `superpowers:writing-plans`（或项目等价流程），读 RFC，先产出 master plan 的 P1（承重最重、其余依赖它），派 subagent 复审 plan，再产出 P2–P4 与 prompts。

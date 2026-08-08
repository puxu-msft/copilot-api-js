# 上游静默与 h2 池事故簇：终态历史与接手索引

> **当前摘要：** direct Anthropic live B2 已实现于 `/v1/messages` 的 delayed-commit pre-ready、ready transport close 与 ready clean EOF before `message_stop` 三个入口；buffered B2 与 translated publication 仍 deferred／fail-closed。backend gate 已通过；最终 merged-state、code、verifier 与 doc reviews 仍进行中。
>
> **权威链接：** 当前架构见 [DESIGN.md](../DESIGN.md)；实现、C4／C5 与验证状态见 [tracked implementation report](2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md)；仍未实现的边界见 [deferred backlog](../todo/deferred-backlog.md)；规范性目标与历史实证见 [upstream-silence spec](../spec/2026-07-23-upstream-silence-commit-timing.md)。本文不再作为易变执行状态的真相源。

## 已完成范围

- B2 以 evaluator → owner C9 batch publication → disposition 的顺序处理 direct Anthropic recovery；仅完整 R 可成为 winner，C9 后不回退 P。
- 三种 keepalive mode、post-commit failure taxonomy、History pinned terminal、C4 V2/V3 双读与 C5 mutation controls 已有可复现证据，细节均在 implementation report。
- backend gate 已通过；命令、退出码、首轮性能波动和第二轮结论均由 implementation report 单独记录。

## Deferred 与未验证边界

- **buffered B2**：须尊重 `max_retries=0`；见 backlog 的“B2 ready-state recovery 的 buffered 路径旁路”。
- **translated publication**：不能复用 direct Anthropic wire／anchor contract；见 backlog 的“translated Anthropic B2 recovery publication”。
- **Q2／Q3／Q8**：真实 GHC 大上下文 fresh-retry 效力、Responses header 时序、GHC pre-content 状态面仍未验证；这些是 spec 的未验证边界，不改变 direct-live 已实现的事实。

## 历史记录：已废，不执行

以下内容记录本事故簇在 2026-07-23～2026-07-28 的调查、计划和迁移上下文。它们不再构成当前执行指令：其中“从 Task 0.6／B1／B2-P0 开工”、“Q5 待测”、“待补 docs”、旧 worktree 路径与旧 kick-off 均已被后续实现或正式文档取代。接手时不得照此重新启动已完成任务。

- deferred-header 的实测证据与“等 header”判别被证伪，已沉淀进 upstream-silence spec；核心教训是 commit 后只发合成脚手架却失去内部恢复能力，B2 以透明 fresh recovery 修复此架构缺口。
- master 曾在特性实施期间重写 delivery／heartbeat 生命周期与 commit deadline；这解释了为何实现采用 owner allocation port、recovery supervisor 和 owner-owned C9，而不复用早期 WeakMap identity 方案。
- 首轮 `test:backend` 曾显示 History capture-performance ratio 8.816 > 8；该单测随后连续 10 次通过，第二次全 backend 为 0 fail。汇总数字会漂移，gate 以退出码和失败数为准。

## 保留的事故教训

- 不得用 upstream header 是否到达来区分挂起和合法长思考：deferred-header 使它们在 commit 时刻同形。
- post-C9 的部分 R 已具不可逆 client visibility；client-gone、wire-torn 与 commit-failed 不能伪装成 P fallback。
- 正样本 mutation 必须触达被声明的机制。仅改变 callback 已结算后的返回值无法证明 post-C9 fallback 防线；有效控制必须跳过 callback 本身。
- 绝不触及用户的 4141 主服务器。真实 GHC 验证若再开展，必须走隔离的非 4141 实例。

## 历史锚点

本事故簇的早期决策与实验记录保留在 git history及以下文档：

- h2 容量选路与 pre-response retry：[2026-07-22 plan](2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md)。
- deferred-header／B2 设计与 Q5 实证：[upstream-silence spec](../spec/2026-07-23-upstream-silence-commit-timing.md)。
- B2-vs-B5 探针：[FINDINGS](../../exp/silence-recovery-b2-vs-b5/FINDINGS.md)。

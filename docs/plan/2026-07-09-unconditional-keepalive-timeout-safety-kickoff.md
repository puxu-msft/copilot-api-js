# Kickoff prompt — 无条件 keepalive timeout-safety 实现

复制以下内容开启实现会话（或交 subagent-driven-development 逐任务派发）：

---

请实现 `docs/plan/2026-07-09-unconditional-keepalive-timeout-safety.md`。

**背景**：live/delayed-commit 路径的纯 pre-response 静默（上游长时间不返回响应头）里，keepalive 退回裸 ping，压不住 Claude Code 的 300s no-real-content watchdog → 客户端 320s 断连（实测 20 条 incident，History `req_1783609043247_663`）。修复=把合成注入器重定位到 handler 层（sink 构造时挂 `heartbeat.injectAnchor`，独立于 driver/pump），无真实 message_start 时合成一个，live pump 外围实时对账。

**权威来源**（冲突时以 spec 为准并回写）：
- spec `docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md` §10（尤其 §10.1.5 架构重定位 C1/C2/H1/H2）。
- ADR `docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md`。

**纪律（CLAUDE.md，必须遵守）**：
- **绝不**运行 `bun run dev`/`start` 或启动服务器；**绝不** `kill`/`pkill`。服务器/oracle 行为验证交用户（no-auto-server）。可跑 `bun run typecheck` / `bunx eslint <path>`（单文件无 `--cache`）/ `bun test <path>`。
- 每语义单元一提交，显式 pathspec，conventional commits，无模型署名。
- TDD：先写失败测试 → 确认失败 → 最小实现 → 确认通过 → commit。
- **commit invariant**：每 commit 终态是一个不变量、中间态绝不半坏；新行为完全接线前对现有 `empty_text` buffered 路径逐字节等价（Phase 2 起用 golden fixture 锁）。
- **retreat 分支绝不碰**（上游 64K 输出上限使其不可达，spec §10.3）。

**阶段顺序**（每阶段一个 commit invariant，见 plan「Commit Invariants」节）：P0 config → P1 原语 → P2 hoist anchorState（含 capturedMessageStart）→ **P3 handler 注入器（核心 incident 修复）** → P4 live 对账 → P5 终末收口 → P6 enveloped_ping → P7 oracle + 回归 → P8 DESIGN.md 同步 + 收尾。

**关键实现期调研步**（plan 已标注）：P4 Task 4.2 Step 0——先读 `pumpAnthropicStreamingV4` 的 live 分支（`runResponseSink`）如何写帧，确认对账 transform 的注入点（`onRenderedFrame` 复用 vs sink 装饰器），据实回写任务。

**收尾（session-closeout skill）**：DESIGN.md 同步 + 跨文档 grep 验证 + plan 状态注解 + 记忆维护 + 交付前 subagent code-review（裁判轴：长远正确 + 完整）。

先通读 spec §10 + plan 全文，再从 P0 Task 0.1 开始。

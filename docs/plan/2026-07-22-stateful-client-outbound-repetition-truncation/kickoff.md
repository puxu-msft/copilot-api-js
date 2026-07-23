# Kick-off 提示词 — 有状态 client.outbound + 重复截断

复制以下内容到新会话 / subagent 启动实施。

---

你要实施 copilot-api-js 的「有状态 client.outbound + 重复输出截断」特性。

**先读（按序）：**
1. 权威 spec：`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`（什么/为何，四轮审查 0 blocker）。
2. 计划总览：`docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/README.md`——**「Produces / 冻结契约」+「红线」+「相位 DAG」是跨相位单一事实源**。
3. 项目指令：`CLAUDE.md`（工作哲学、纪律、测试分档、并发会话行级共存）。
4. 相关 skill：`test-isolation`（后端单例隔离）、`large-refactor`（golden 预捕 + commit invariants）、`client-proxy-e2e-testing` / `pty-terminal-ui-testing`（idle 回归）、`empirical-verification`（4141 探针纪律）、`bun-node-runtime-gotchas`。

**执行纪律：**
- 严格 TDD：每任务先写失败测试 → 跑证失败 → 最小实现 → 跑证通过 → 显式 pathspec 提交。
- 相位串行：P0 → P1 → P2 → P3 → P4 → P5（见 DAG）。**不得**跳相位或先翻默认。
- **红线是硬约束**：R1（字节等价）、R2（eager-start 同 commit）、R3（classifier 留 postRender）、R4（provenance 全站点同 commit）、R5（M-2 门后才升级默认）、R6（landing 关 backlog/doc）。
- **绝不碰 4141 主服务器**；测试实例起在非 4141 端口、按 PID 精确清理。
- byte-critical 阶段（P3）先 golden 四格式预捕、每 commit 回放等价。
- 收尾按 skill `session-closeout`：subagent 审 → doc-sync（DESIGN.md 活架构行 + streaming.md 行为表 + deferred-backlog §9 关闭 + Gemini 排除条）→ 归档 → 记忆 → 细粒度提交。

**从哪个相位开始：** <填 P0 / 具体相位>。读该相位 `plan-<N>-*.md`，逐任务复选框推进。

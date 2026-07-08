# Kick-off prompt: buffered `empty_text` 合成锚点 keepalive 实施

复制以下内容开启新会话执行本计划。

---

你的任务：实施 [docs/plan/2026-07-08-buffered-keepalive-empty-text-anchor.md](docs/plan/2026-07-08-buffered-keepalive-empty-text-anchor.md)。

**背景（读这两份权威文档）：**
- 计划：`docs/plan/2026-07-08-buffered-keepalive-empty-text-anchor.md`（分阶段 TDD 任务，逐 Task 执行）。
- 规格：`docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md`（权威；实现与它冲突时以 spec 为准并回写 spec）。
- 起因：Claude Code 对 buffered 模式（`protect_streaming_generation`）的 heavy-thinking 请求在 ~300s 撞 no-real-content watchdog 断连。修复 = 新增 `stream_keepalive_mode: empty_text`（新默认），buffered pre-commit 无 open block 时懒注入合成空 text 锚点块保活。

**执行方式：** 用 `superpowers:subagent-driven-development`（推荐，每 Task 一个 fresh subagent + 两阶段 review）或 `superpowers:executing-plans`（本会话批执行 + 检查点）。逐 Task 走 TDD 五步（写失败测试→确认失败→最小实现→确认通过→提交）。

**本项目硬约束（务必遵守）：**
- **no-auto-server**：绝不跑 `bun run dev/start` 或任何启动服务器的命令，不 `kill`。可跑 `bun test` / `bun run typecheck` / `bunx eslint <path>` / `bun run lint:all`。
- **Phase 6（真实 CC oracle）是上线门控且需启动服务器**——代码/脚本由你写，**运行交接给用户**（你输出运行指令、用户贴结果、你据结果填 REPORT + 判定门控）。
- **细粒度 pathspec 提交**：每 Task 一提交，`git add -- <精确路径>`、`git commit -F <msg> -- <精确路径>`，conventional commits，无模型署名。
- **并发会话**：本仓常有并发 agent，共享树则同文件不重叠行 + pathspec commit（免疫 peer 的 index race）；大改动优先 isolated worktree（`.worktrees/`）。
- **合成 Anthropic SSE 帧必经 `anthropicSseFrame(payload)`**（带 `event:` 行，否则 SDK 静默丢帧）。
- **subagent review**：每 Task 实现后派 subagent review（显式裁判轴：长远正确 + 完整，非 ROI/YAGNI）；reviewer 的「无消费者/可删/已通过」等绝对断言须亲自对照代码/实测复核。

**关键实现风险点（计划已详述，勿踩）：**
- **C1 竞态**：commit/终末 flush 前必须先 `sink.freezeHeartbeat()` + 一次性快照 `anchorState.injected`（心跳 timer 会在 flush 的每个 `await` 间隙 fire、中途注入锚点致 index 碰撞）。
- **H1 双发**：commit flush 必须跳过任何已转发的 `message_start`（同 attempt + 跨重试都双发风险）。
- **H2 层次**：`driver.ts` format-agnostic，不能自造 Anthropic 帧——锚点帧 + remap 由 handler 经 `RunBufferedOpts.anchor` 注入，driver 只编排。
- **懒注入字节等价**：未注入锚点（快响应）路径必须与 `content_delta` 模式逐字节相同。

**收尾（session-closeout）：** 全量 `bun test` + `typecheck` + `lint:all` 绿；doc-sync（DESIGN.md 活的架构现状 + streamKeepaliveMode 选项行 + 前身 spec §6#3 标注兑现）；归档 plan 加实施状态注解；提炼教训维护记忆库。

从 **Phase 0 Task 0.1** 开始，逐 Task 推进。方向明确别停问，遇矛盾/破坏性/门控（Phase 6 运行）才停。

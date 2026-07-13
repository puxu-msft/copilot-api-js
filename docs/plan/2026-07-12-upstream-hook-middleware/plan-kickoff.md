# Kickoff：上游 hook 中间件实施（复制用）

```
实施「上游 hook 中间件」特性。先读：
- 权威 spec：docs/spec/2026-07-12-upstream-hook-middleware.md（已定稿 v2，2 轮对抗评审 + 实测核实）
- 实施计划：docs/plan/2026-07-12-upstream-hook-middleware/README.md（阶段 DAG）+ plan-0..5
- 项目 CLAUDE.md（纪律）

特性一句话：在 proxy 上游边界（Transport.send）引入 driver 编排的三挂载点 ad-hoc hook
（onRequest 一次性 / onExchange 核心包 transport.send / rewriteUpstreamFrame 逐帧），
config 声明 TS 文件 mock/拦截/录制回放/注入故障上游、不真发 GHC；录制复用 history.db；
热重载仅 POST /api/hooks/reload（Bun data-URL 机制，非 ?v=）。

执行方式：用 superpowers:subagent-driven-development 逐任务实施（fresh subagent per task + 两阶段评审）。
按 DAG 顺序：Phase 0（地基）→ Phase 1+2（driver 挂载点 + history 标记，连做）→ Phase 3（helper，可并行）
→ Phase 4（API + 根路径）→ Phase 5（集成 + 收尾）。

隔离：本特性中大型、多文件，建议 superpowers:using-git-worktrees 起隔离 worktree（.worktrees/）+ 独立分支。

红线（每 commit）：typecheck + typecheck:ui-v4 绿；hooks 未配置时字节等价（golden oracle，Task 1.0 先建）；
上游轨绝不含未标记合成物；warn-continue 绝不杀进程；热重载固定 data-URL 绝不 ?v=。

纪律：TDD（每任务先写失败测试）；protect-user-main-server（集成实测非 4141 端口 + PID 精确 kill）；
显式 pathspec commit；独立 oracle 校验（格式 mock 用 accumulator 重建、reactive 策略真跑 driver 观测触发，非自证）；
收尾走 session-closeout 五步 + subagent 合并态评审。
```

## 执行前须知

- **Phase 0 是硬地基**：所有后续依赖 `getUpstreamHook()` + `UpstreamHook` 类型，务必先 landed。
- **Task 1.0（golden 预捕获）在改 driver 前做**：锁 master 行为作 oracle，否则字节等价无从证。
- **两处降级决策点**：Task 2.3（`hook-rewrite` forwarded 标记若太深可降级 + 记 backlog，但上游轨纯净是硬底线）；Task 5.4 ADR（够格则补，否则记理由）。
- **data-URL 机制无先例**：loader 首次引入 `Bun.Transpiler` + data-URL，spec §6.3 + 记忆 reference-bun-esm-cache-busting 有实测依据，别退回 `?v=`。

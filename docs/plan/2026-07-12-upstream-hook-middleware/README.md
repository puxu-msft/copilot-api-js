> **命名已于 v3（2026-07-15 合并 master `2a77bf7c`）迁移**：本文件夹是 v2 实施记录（扁平 `onRequest`/`onExchange`/`rewriteUpstreamFrame`）。最新形状 = 对称四点 `hooks.{client,upstream}.{inbound,outbound}`+`exchange`，权威见 RFC `docs/rfc/2026-07-14-symmetric-four-point-hooks.md` + spec `docs/spec/2026-07-12-upstream-hook-middleware.md` §3.2/§12。

# 上游 hook 中间件 — 实施计划 README（阶段 DAG + 总览）

> **给执行者**：REQUIRED SUB-SKILL：用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框追踪。
> **权威 spec**：[../../spec/2026-07-12-upstream-hook-middleware.md](../../spec/2026-07-12-upstream-hook-middleware.md)（已定稿 v2，2 轮对抗评审 + 实测核实）。
> **实施状态**：**已实施** —— landed on `feat/upstream-hook-middleware`，Phase 0-5.3 全绿（24 commits），Task 5.4 收尾已完成 I-1 测试隔离修复（`resetUpstreamHook` 登记进全局 RESETTERS 表）+ doc-sync（本 README + 各 plan-N 头部 + [DESIGN.md](../../DESIGN.md) + spec §9 措辞澄清 + 新 [ADR](../../decisions/2026-07-12-driver-orchestrated-upstream-hooks.md)），待合并 master。Task 5.4 尚余：backlog 补记（上游 WS 腿 hook / attempt 级 source provenance）、[MEMORY.md](../../memory/MEMORY.md) 记忆维护、最终合并——见 [plan-5-integration-closeout.md](plan-5-integration-closeout.md) 未勾选项。

**Goal**：在 proxy 上游边界引入 driver 编排的多挂载点 ad-hoc hook，让开发者用 config 声明的 TS 文件 mock/拦截/录制回放/注入故障上游响应，不真发 GHC。

**Architecture**：新 `src/lib/pipeline/hooks/` 模块（loader 单例 + helper 工具箱）；`createPipelineDriver` 内部在三个 phase 边界读 `getUpstreamHook()` module-global 回调挂载点（未配置=直通、生产零开销）；录制-回放复用 history.db；热重载仅 `POST /api/hooks/reload`（Bun data-URL 机制）。

**Tech Stack**：Bun 1.3.14 runtime、Hono + @hono/zod-openapi、Zod config、bun:test、`Bun.Transpiler` + data-URL 动态加载。

## Global Constraints（每个任务隐含包含）

- **protect-user-main-server**：绝不 kill 4141 端口主服务器；集成测试在**非 4141 端口**起隔离实例、按 PID 精确 kill 自己起的。
- **concurrent-sessions 行级共存**：优先隔离 worktree（`.worktrees/`）+ 独立分支；共享树则显式 pathspec commit（`git commit -- <精确路径>`）。
- **热重载机制固定为 data-URL**：`读盘 → new Bun.Transpiler({loader:"ts"}).transformSync(src) → import("data:text/javascript," + encodeURIComponent(js))`。**绝不用 `?v=` query**（Bun 实测忽略 query 返回旧模块，见 spec §6.3）。
- **warn-continue 绝不杀进程**：hook 加载/重载/执行失败一律 warn + 保留旧值/直通，绝不 `process.exit`。
- **上游-original track 绝不含未标记合成物**：hook mock/改写/回放帧进 history 上游轨必打 `synthetic` 标记（richest-data-flow ADR）。
- **默认关闭**：`hooks.enabled` 默认 `false`；未配置时所有挂载点直通、字节等价。
- **命名**：逐帧挂载点是 `rewriteUpstreamFrame`（非 `onUpstreamFrame`，避与既有 `RunResponseOpts.onUpstreamFrame` 混淆）。

## 阶段 DAG（依赖关系）

```
Phase 0 (loader + config + origin.ts 地基) ─┬─→ Phase 1 (driver 三挂载点) ─┬─→ Phase 5 (集成测试 + 收尾)
                                            │                            │
                                            ├─→ Phase 2 (history 可辨识性) ┤
                                            │                            │
                                            ├─→ Phase 3 (helper 工具箱) ───┤
                                            │                            │
                                            └─→ Phase 4 (API 路由 + 根路径) ┘
```

- **Phase 0** 是地基（loader 单例 + config section + `origin.ts` 标记原语），所有后续依赖 `getUpstreamHook()`/`UpstreamHook` 类型 + `tagStream`/`readOrigin`。
- **Phase 1**（driver 挂载点）与 **Phase 2**（history 标记）耦合紧（rewriteUpstreamFrame 的标记落点），建议同一执行者连做。
- **Phase 2 / Phase 3 / Phase 4 三者相互独立、均只依赖 Phase 0**，可真并行（评审 HIGH-1：`origin.ts` 上移 Phase 0 后，Phase 3 不再依赖 Phase 2）。
- **Phase 5**（集成 + 收尾）依赖全部。

## 阶段文件

- [plan-0-loader-and-config.md](plan-0-loader-and-config.md) — loader 单例（data-URL 加载）+ hooks config section 全套接线。
- [plan-1-driver-hookpoints.md](plan-1-driver-hookpoints.md) — driver 三挂载点 + 未配置字节等价 golden。
- [plan-2-history-provenance.md](plan-2-history-provenance.md) — 扩 synthetic 联合 + mock/rewrite/replay 帧标记 + 上游轨录 pre-hook。
- [plan-3-helper-toolkit.md](plan-3-helper-toolkit.md) — sse/streamOf/mockXxx/mockUpstreamError+预设/replayFromHistory/delay/truncateAfter。
- [plan-4-api-and-root.md](plan-4-api-and-root.md) — GET /api/hooks + POST /api/hooks/reload + 根路径重定向。
- [plan-5-integration-closeout.md](plan-5-integration-closeout.md) — reactive retry 腿实测、回放实测、reload 实测、doc-sync + 归档。
- [plan-kickoff.md](plan-kickoff.md) — 新会话/执行者启动指令（复制用）。

## 红线（commit invariants，每 commit 终态不变量）

- 每个 commit 后 `bun run typecheck` + `bun run typecheck:ui-v4` 绿（`~backend/*` 纯度）。
- Phase 0 landed 后：`hooks` 未配置时，`bun test` 全绿、driver 行为字节等价（golden oracle）。
- 任何 commit 中间态绝不半坏（删函数但调用方仍引用 = 禁止）。
- `hooks.enabled:false`（默认）时全链路零行为改变——这是每个 Phase 的回归底线。

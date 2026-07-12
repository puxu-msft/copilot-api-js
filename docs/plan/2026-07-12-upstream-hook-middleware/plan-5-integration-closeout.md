# Phase 5：集成实测 + 收尾

> 依赖：Phase 0-4 全部。产出：端到端实测（reactive retry 腿、离线回放、reload、L2 交互）+ doc-sync + 归档。
> **纪律**：protect-user-main-server——集成实测在**非 4141 端口**起隔离实例、按 PID 精确 kill 自己起的（绝不 pkill/killall）。

---

## Task 5.1：reactive retry 腿端到端实测（核心动机）

**Files:** Create `tests/pipeline/hooks/reactive-retry-leg.it.test.ts`（或起隔离服务器脚本 + 探针）。

**独立 oracle（评审 H3，非自证）**：挂 `mockUpstreamError.toolFieldRejection()` hook，发一个带 tool 的 Anthropic 请求，观测 **reactive 策略真被触发**（retry 腿走了）——不是只信 hook 自报，而是查 history 的 attempts 出现 strategy 标记 / 第二 attempt。

- [ ] **Step 1：写测试** — 起隔离实例（非 4141）挂 fixture hook（`onExchange` 首 attempt `toolFieldRejection()`、后续 `next` 或 mock 成功）；发请求；断言 history entry 有 ≥2 attempts、首 attempt error 是 400 tool-field、strategy 被记录。
- [ ] **Step 2：跑绿**（flaky/时序敏感则连跑确认确定性）。
- [ ] **Step 3：commit**。

## Task 5.2：离线回放实测

**Files:** Create `tests/pipeline/hooks/replay.it.test.ts`。

- [ ] **Step 1：写测试** — 先真发一次（或塞一条已知 history entry），挂 `replayFromHistory(reqId)` hook 再发同请求，断言：**无真实 GHC 调用**（mock transport 计数 0 / 隔离实例无出网）、回放帧带 `synthetic:"hook-replay"`、Anthropic 无损、CC/Gemini 不注入伪造 event 行（评审 H4）。
- [ ] **Step 2：跑绿** → **Step 3：commit**。

## Task 5.3：reload + L2 buffered-retry 交互实测

**Files:** Create `tests/pipeline/hooks/reload-and-l2.it.test.ts`。

- [ ] **Step 1：写测试** —
  - reload：起实例挂 hook v1、`POST /api/hooks/reload` 后改 fixture、再 reload → `GET /api/hooks` 反映新 version；坏 fixture reload → 保留旧 + `lastReloadError` 可查。
  - L2 交互（评审 M1/L1）：挂 `onExchange` 计数 hook + 开 `responsesBufferedRetry`，断言调用次数 = L1×L2 符合预期、次序正确。
- [ ] **Step 2：跑绿** → **Step 3：commit**。

## Task 5.4：收尾（session-closeout 五步）

- [ ] **doc-sync**：更新 [docs/DESIGN.md](../../DESIGN.md)「活的架构现状」加 hook 挂载点行（driver 编排三挂载点、config-gated、data-URL reload）；配置节加 `hooks` section。跨文档 grep 验证引用一致。
- [ ] **ADR 判定**：hook 机制是新架构层——补 `docs/decisions/2026-07-12-driver-orchestrated-upstream-hooks.md`（记「为何 driver 编排多挂载点而非 transport decorator」+「为何 data-URL 而非 ?v=」），或评审认为不够格则跳过并记理由。
- [ ] **backlog**：上游 WS 腿 hook、`hook-rewrite` forwarded 标记（若 Task 2.3 降级）、attempt 级 `source` provenance → [docs/todo/deferred-backlog.md](../../todo/deferred-backlog.md)。
- [ ] **plan 归档**：本 plan 目录头部标注实施状态（landed/partial）；README 更新 DAG 完成态。
- [ ] **记忆维护**：更新 [project-upstream-hook-middleware](../../memory/project-upstream-hook-middleware.md) stub 为 landed；`reference-bun-esm-cache-busting` 若下沉 skill `bun-node-runtime-gotchas` 则改 stub。
- [ ] **subagent 合并态评审**：全部 landed 后派 subagent 做 merged-state review（doc-vs-code 对账、集成接缝、上游轨纯净不变量的实际验证）。
- [ ] **最终提交 + 合并**：若用隔离 worktree，走 `superpowers:finishing-a-development-branch` 合回 master。

**Phase 5 出口验收**：核心动机（reactive retry 腿）端到端实测通过、回放无出网、reload 生效、doc/记忆同步、合并态评审无 BLOCK。

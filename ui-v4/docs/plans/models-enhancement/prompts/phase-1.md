# Kick-off — Phase 1（遥测地基）

复制以下内容到新会话：

---

你在 copilot-api-js 仓库实施「ui-v4 Models 页全面增强」的 **Phase 1（遥测地基）**。

先读（按序）：
1. `docs/plan/ui-v4-models-enhancement/README.md`（总纲 + Global Constraints + 红线）
2. `docs/plan/ui-v4-models-enhancement/phase-1-telemetry-foundation.md`（本 phase 逐 task TDD 步骤）
3. `docs/spec/2026-07-05-ui-v4-models-enhancement.md` §4（遥测设计权威源）

用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施，勾选 checkbox。

**本 phase 范围**：纯逻辑、全 bun 测、**无 UI 改动**。① 从 `ui/src/composables/useDashboardStatus.ts:209-280` 抽出 `parseRequestTelemetry` 纯函数（+ 遥测类型迁到 `telemetry-parse.ts` 成 SSOT，`useDashboardStatus` re-export）；② 建 `model-telemetry-join.ts` 的 `buildModelTelemetryIndex`（**双侧 `normalizeModelId` 归一化** join + 同 key 聚合 + **unmatched 收集不丢弃**）。

**红线**：类型从 `~backend` 导入不重定义；parse 抽取须逐字节等价（`useDashboardStatus` 消费者不破）；join 不上的遥测进 `unmatched`（richest-data-flow）；**不碰 `CLAUDE.md`**（并发会话所有）；pathspec 精确提交（**绝不** `git add -A`）；命令走 `bun run`。

**验证**：`bun run test:ui:bun` + `bun run typecheck:ui` 全绿。收尾派 subagent audit（裁判轴：长远正确 + 完整 + 覆盖 §4.2 全部失配形态，**非** ROI/最小化）。

从 phase-1 的 Task 1 Step 1 开始。

# Kick-off — Phase 2（详情抽屉 + 全字段 + 后端暴露）

复制以下内容到新会话：

---

你在 copilot-api-js 仓库实施「ui-v4 Models 页全面增强」的 **Phase 2（详情抽屉 + 全字段 + 后端暴露）**。**前置：Phase 1 已完成**（`telemetry-parse.ts` + `model-telemetry-join.ts` 已就绪）。

先读（按序）：
1. `docs/plan/ui-v4-models-enhancement/README.md`（总纲 + Global Constraints + 红线）
2. `docs/plan/ui-v4-models-enhancement/phase-2-detail-drawer.md`（逐 task TDD）
3. `docs/spec/2026-07-05-ui-v4-models-enhancement.md` §3/§5/§6/§13（字段映射、组件边界、6 tab、后端暴露）
4. ADR `docs/decisions/2026-07-05-internal-tool-security-posture.md`（后端 `request_headers` 暴露依据）

用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐 task 实施。

**本 phase 范围**：① 后端移除 `stripInternalFields` 对 `request_headers` 的剥离（`src/routes/models/internal.ts`，唯一后端改动）；② `useModelDetail`（选中 id + 抽屉开关 + 遥测 join）；③ `DetailSection`/`DetailKeyValueList` 原语；④ 6 tab（全字段，**Capabilities 展示完整 raw supports map**、Vision 条件区块、Telemetry 全 6 项 token）；⑤ `ModelDetailDrawer`（`v-navigation-drawer` + 补 vitest stub）；⑥ 接线 VModelsPage + **抽屉替换 ModelsTable 行内展开**。

**红线**：`useModelsCatalog` 非单例——子组件绝不各自调它，数据经 props 下传；**选中态存 `model.id` 字符串，绝不复制 model 对象**（WeakMap caps 缓存）；Capabilities **不裁剪**到派生子集（展示 raw supports）；Raw JSON 用内嵌 `JsonViewerSurface`，**不用 `provideRawModal`**；`deriveCapabilities`/`Model` 从 `~backend` 导入；不碰 `CLAUDE.md`；pathspec 提交。改后端 `.ts` 后跑 `bun run typecheck`（后端）+ `bun run test:backend`（models 子集）。

**验证**：`bun run typecheck:ui` + `bun run typecheck` + `bun run test:ui:vitest`/`test:ui:bun` + 后端 models 测试全绿。收尾派 subagent audit（裁判轴：全字段无遗漏对照 §3、full supports、抽屉真替换行内展开无双重交互、request_headers 真透传；**非** ROI/最小化）。

从 phase-2 的 Task 1 开始。

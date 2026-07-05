# ui-v4 Models 页面全面增强 — 实施计划（总纲）

> **实施状态：已完成**（全 4 phase 落地，主线实现 + 每 phase subagent audit）
> **落地**：2026-07 · commits `6865f0b`（Phase 1 起）… `33bd5b6`（doc-sync）（best-effort，rebase/squash 后可能失效）
> **现状锚点**：[ui/CLAUDE.md `/models` 路由行](../../../ui/CLAUDE.md) · 代码 [ui/src/components/models/](../../../ui/src/components/models/) + [ui/src/composables/{useModelDetail,model-telemetry-join,telemetry-parse,useModelColumns}.ts](../../../ui/src/composables/) · spec [2026-07-05-ui-v4-models-enhancement.md](../../spec/2026-07-05-ui-v4-models-enhancement.md)
> **备注**：唯一后端改动＝移除 `stripInternalFields`（按 ADR internal-tool-security-posture 暴露 `request_headers`）。测试 vitest 103 + bun-ui 270 + 后端 models 102 全绿。

> **For agentic workers:** REQUIRED SUB-SKILL — 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施。步骤用 `- [ ]` checkbox 跟踪。
> **权威 spec**：[docs/spec/2026-07-05-ui-v4-models-enhancement.md](../../spec/2026-07-05-ui-v4-models-enhancement.md)。本计划是其实施分解，冲突以 spec 为准。

**Goal:** 把 ui-v4 Models 页从"密集表格 + 行内原始 JSON 展开"升级为"密集表格 + 右侧详情抽屉（6 tab，全字段）+ 运行遥测 join（含未关联遥测可见）+ 列可配置 + 新过滤 + CSV 导出"。

**Architecture:** 复用现有 `useModelsCatalog` + `deriveCapabilities`（`~backend`）+ `JsonViewerSurface`；新增页面作用域 `useModelDetail`（选中 id + 抽屉开关 + 遥测 join）、`useModelColumns`（列配置 + `useLocalStorage`）、`ModelDetailDrawer`（`v-navigation-drawer`）+ `DetailSection` 共享原语、`telemetry-parse.ts`（从 `useDashboardStatus` 抽出的纯函数）、`models-csv.ts`（纯序列化）。遥测在 `onMounted` 一次性 `fetchStatus`（无轮询、无 WS）。抽屉**替换**现有行内展开。

**Tech Stack:** Vue 3.5 `<script setup>` + Vuetify 4.1 + `@vueuse/core` 14 + Vite；测试 bun（纯逻辑，`ui/tests/`）+ vitest（DOM，`ui/vitest/`，`mountWithVuetifyStubs`）。

## Global Constraints（每个 task 隐含包含）

- **测试双轨**：纯逻辑/序列化/join → **bun**（`ui/tests/*.test.ts`，`bun run test:ui:bun`）；组件挂载/交互 → **vitest**（`ui/vitest/*.test.ts`，`bun run test:ui:vitest`）。
- **类型 SSOT**：`Model`/`DerivedCapabilities` 从 `~backend` 导入，**绝不**前端重定义；非平凡 composable **必须导出返回类型接口**（`UseXxxReturn`）。
- **`useModelsCatalog` 非单例**：子组件**绝不**各自调它；数据经 props/provide 从页面单一实例下传。
- **选中态存 `model.id`（字符串），绝不复制 model 对象**（否则 `caps()` WeakMap 缓存 miss）。
- **复用 primitive、禁止手搓**：`useLocalStorage`（列配置）、`onKeyStroke`+`isTyping()`（键盘）、`useCopyToClipboard`（复制）、`JsonViewerSurface`（JSON）、`getEffectiveEndpoints`（端点推断）、`deriveCapabilities`/页面 `caps()`。CSV 下载复用 `export-entry.ts` 的 `triggerDownload` anchor 模式。
- **richest-data-flow**：全字段 `?.` + 缺失显示 `—`；Capabilities tab 展示**完整 raw `supports` map**（非仅派生子集）；未 join 到 `model.id` 的遥测进"未关联遥测"小节，**不静默丢弃**。
- **样式**：全局 `rounded:0`、amber 主色、`--v-theme-*` token、`tabular-nums` 对齐数字、VChip `size="x-small" variant="tonal"`。
- **命令走 `bun run`**（非 `npm run`）；`.vue`/`.ts` 改动跑 `bun run typecheck:ui`；不启动 dev server。
- **提交**：一 task 一 commit，conventional（`feat(ui)/test(ui)/refactor(ui)/docs`），不加 Claude 署名；pathspec 精确暂存（仓库有并发会话，**绝不** `git add -A`）。**不碰 `CLAUDE.md`**（另一会话在改）。

## 后端唯一改动（Phase 2 内）

移除 `src/routes/models/internal.ts` 的 `stripInternalFields` 对 `request_headers` 的剥离（按 ADR `internal-tool-security-posture`，见 spec §13）。这是全计划**唯一**后端改动，改后 `.ts` 须跑 `bun run typecheck`（后端）+ 相关 `bun run test:backend` 子集。

## Phase DAG 与交付物

```
Phase 1 (遥测地基) ──┐
                     ├─► Phase 2 (抽屉 + 全字段 + 后端暴露) ──► Phase 3 (表格/过滤/列配置) ──► Phase 4 (CSV + a11y + 文档)
useModelsCatalog ────┘
(已存在, 各 phase 扩展)
```

- **Phase 1** — [phase-1-telemetry-foundation.md](phase-1-telemetry-foundation.md)：抽 `parseRequestTelemetry` 纯函数（解耦 `useDashboardStatus` 的 WS）+ `normalizeModelId` 双侧归一化 join + unmatched 收集。**纯逻辑，全 bun 测**，无 UI。交付：`telemetry-parse.ts`、`useModelDetail` 的 join 核（先纯函数形态）。
- **Phase 2** — [phase-2-detail-drawer.md](phase-2-detail-drawer.md)：`useModelDetail`（选中+开关+join）+ `ModelDetailDrawer` + `DetailSection` 原语 + 6 tab（全字段，含 raw supports/Vision 条件区块/Telemetry/Raw JSON）；抽屉**替换**行内展开；后端暴露 `request_headers`；vitest 补 stub。交付：可点行开抽屉看全字段 + 遥测。
- **Phase 3** — [phase-3-table-filters-columns.md](phase-3-table-filters-columns.md)：遥测列 + 新过滤谓词（premium/restricted-to/policy/has-telemetry）+ `useModelColumns`（列显隐 + localStorage）+ toolbar 齿轮菜单 + "未关联遥测"小节。
- **Phase 4** — [phase-4-csv-a11y-docs.md](phase-4-csv-a11y-docs.md)：`models-csv.ts` + Export CSV 按钮 + 抽屉 a11y（焦点/aria/Esc）+ 文档卫生（归档 `docs/2604-ui-models/`、回填 DESIGN/ui-CLAUDE）。

## 红线（RED-LINES，任何 phase 违反即停）

1. **绝不**前端重新 `deriveCapabilities` 或重定义 `Model`/`DerivedCapabilities`——从 `~backend` 导入。
2. **绝不**在子组件里调 `useModelsCatalog()`——数据从页面单一实例经 props 下传。
3. **绝不**复制 model 对象存进选中态——存 `model.id`，抽屉按 id 反查页面 `models`。
4. **绝不**静默丢弃 join 不上的遥测——进 unmatched 小节。
5. **绝不**用 `provideRawModal`/额外 modal 叠在抽屉上——抽屉 Raw JSON tab 内嵌 `JsonViewerSurface`。
6. **绝不**手搓 localStorage/点外关闭——用 `useLocalStorage`/Vuetify 原生 scrim + `onKeyStroke`。
7. **绝不**碰 `CLAUDE.md`（并发会话所有）。

## 每 phase 收尾

跑 `bun run typecheck:ui`（+ Phase 2 后端 typecheck）+ **`bun run build:ui`**（真实 rollup bundle——typecheck+stub 测试会假绿放过"前端拖入后端运行时 import"，只有 build 暴露，见记忆 [[feedback-verify-ui-with-build-not-just-typecheck]]）+ 对应 `bun run test:ui:bun`/`test:ui:vitest` 全绿 → 一 task 一 commit → phase 末派 subagent audit（显式裁判轴：长远正确 + 完整 + richest-data-flow，非 ROI/YAGNI）。全计划收尾走 `session-closeout` 五步。

## Kick-off prompts

每 phase 一个自包含 kick-off，见 [prompts/](prompts/)：`phase-1.md` … `phase-4.md`。新会话直接复制对应 prompt 即可。

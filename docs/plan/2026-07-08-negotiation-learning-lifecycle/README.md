# 反应式学习记录 生命周期 + 查看/编辑页面 · 实施计划总览

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 给反应式学习记录（feature-negotiation 缓存）加 TTL 生命周期（首学/最后确认时间戳、按分类可配 TTL 默认 30d、自动过期、每条可 pin 永不过期），暴露 `/api/negotiation` 管理 API，并在 ui-v4 建「Learned」页面（按功能分组查看 / 整体导出 v2 JSON / 续约·立即失效·pin·删除）。

**Architecture:** 后端在 [feature-negotiation.ts](../../../src/lib/anthropic/feature-negotiation.ts) 把 10 个 `Map<key, Set<value>>` 升为 `Map<key, Map<value, LearnedEntryMeta>>`，生命周期判定收敛到单一 `isEntryActive` primitive（新 leaf `negotiation-lifecycle.ts`）；配置走既有 hot-reload 五触点；新 OpenAPIHono 路由暴露分组快照 + 四个 POST 编辑动作 + 导出。前端 React 页面经 `~backend/*` re-export 类型、react-query hook 消费。

**Tech Stack:** TypeScript · Bun（后端 + `bun test`）· Hono/@hono/zod-openapi · Zod · React 18 + react-router（hash）+ @tanstack/react-query · Vite/Vitest（jsdom）· UnoCSS。

**Spec:** [docs/spec/2026-07-08-negotiation-learning-lifecycle.md](../../spec/2026-07-08-negotiation-learning-lifecycle.md)（权威需求）。

## Global Constraints

- **无 pre-commit 门禁**：lint 靠手动 `bunx eslint <path>`（单文件核验须无缓存）+ subagent review；`bun run typecheck` / `bun run lint:all` / `bun test` 可跑。→ CLAUDE.md。
- **no-auto-server**：绝不跑 `bun run dev/start` 或任何起服务器命令；不 `kill`/`pkill`。API 行为验证靠单元/集成测试（Hono app 直接 `.request()`），或让用户手动起服务器。
- **细粒度 pathspec 提交**：`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`；conventional commits；不加模型署名。
- **concurrent-sessions**：`src/lib/state.ts` 常被并发会话改动 —— 改它前 `git status` 查外来未提交改动，只改本任务需要的行、显式 pathspec 提交，绝不整文件退让。
- **测试隔离**：feature-negotiation 测试用 per-file `PATHS.NEGOTIATION_STATES` 临时目录覆盖 + `afterEach` reset（见 backend.md B1 harness），绝不碰真实 `~/.copilot-api/negotiation-states.json`。
- **richest-data-flow**：后端快照/导出输出全量元数据 + 四态 status（`active`/`expired`/`pinned`/`manually_expired`）；前端可选择性呈现（合并「已过期」徽章）。
- **穷尽消费点**：过期记录必须在**每个** exported reader 读作「未学过」—— 漏一个则过期记录仍生效。B4 逐 reader gate + 每分类守卫测试。
- **SSOT-types**：新类型在后端定义、前端经 `ui-v4/src/types/index.ts` 的 `export type … from "~backend/…"` re-export，绝不在前端重定义。

## 阶段 DAG

```
Phase 1 (backend.md)  ──────────────►  Phase 2 (frontend.md)
  B1 lifecycle primitive                  F1 api.post + types + useLearned
  B2 v1→v2 migration                      F2 LearnedPage + nav + route
  B3 markX re-confirm (×10)               F3 整体导出按钮
  B4 reader gating (×12)                  F4 vitest + build:ui
  B5 mutations + resolver + snapshot
  B6 config TTL 五触点
  B7 /api/negotiation route + mount
  B8 reset helpers + 集成测试
```

- **Phase 1 是 Phase 2 的硬前置**：F1 消费 B7 冻结的 API 契约（`GET /api/negotiation` 响应 + 四个 POST）。Phase 1 单独即可交付（curl/集成测试可验的管理 API）。
- **Phase 1 内部顺序**：B1→B2→B3→B4 严格递进（都改 feature-negotiation.ts 核心）；B5 依赖 B1 的 resolver 基础；B6 可与 B1–B5 并行（另文件），但 B1 的 `categoryTtlMs` 消费 B6 的 state 字段 —— B6 先落 state 默认值即可解耦（B1 用默认、B6 补 config 接线）。B7 依赖 B5。

## 冻结的 API 契约（Phase 2 依赖，B7 产出）

```
GET  /api/negotiation          → LearnedSnapshot（见 backend.md B5）
POST /api/negotiation/renew    { category, key, value }        → { ok: true, entry: LearnedEntryView }
POST /api/negotiation/expire   { category, key, value }        → { ok: true, entry: LearnedEntryView }
POST /api/negotiation/pin      { category, key, value, pinned } → { ok: true, entry: LearnedEntryView }
POST /api/negotiation/entry/delete { category, key, value }     → { ok: true }
GET  /api/negotiation/export   → 完整 v2 数据集 JSON（Content-Disposition: attachment）
```

不存在的条目：renew/expire/pin/delete 返回 `404 { error: "entry not found" }`。

## 红线 / 不变量

1. **`isEntryActive` 是唯一过期判据**（`negotiation-lifecycle.ts`）：`pinned` → 永活；`manuallyExpired` → 死；否则 `now <= lastConfirmedAt + categoryTtlMs`。任何消费点都经它，不各自判。
2. **meta 刷新 ≠ 返回值变**（B3）：`markX` re-hit 刷新 `lastConfirmedAt` + 清 `manuallyExpired`（副作用），但 `setSupportedEfforts` 等的 `changed` 返回值语义不变（驱动 retry driver）。
3. **门控只在 reader，mutator/快照/导出读原始**（B4/B5）：快照要显示过期行，绝不能经门控 reader 过滤掉。
4. **v1→v2 单向迁移**（B2）：旧格式读时适配（`migrated: true`、`firstLearnedAt=lastConfirmedAt=now`），写时升级 `version: 2`，legacy `serverToolHistoryDowngrade` 仍读。不留双轨。
5. **config 五触点齐全**（B6）：schema + config.ts 接线 + state（MutableState + setter + CONFIG_MANAGED_DEFAULTS + 4 clone 站点）+ mergeConfigIntoDocument 专用分支 + effective-config 守卫，缺一则 `PUT /api/config/yaml` 报错或不 round-trip。

## Kick-off Prompts

### Phase 1（backend）
```
实施 docs/plan/2026-07-08-negotiation-learning-lifecycle/backend.md（Phase 1，反应式学习记录 TTL 生命周期 + /api/negotiation 管理 API）。先读该文件全文 + docs/plan/.../README.md 的「Global Constraints / 红线」+ spec docs/spec/2026-07-08-negotiation-learning-lifecycle.md。逐任务 TDD（先写失败测试→跑红→最小实现→跑绿→pathspec 提交）。改 src/lib/state.ts 前先 git status 查并发外来改动、只改本任务行。no-auto-server：不起服务器、API 靠 Hono .request() 集成测试验。每任务末跑 bunx eslint <改动文件>（无缓存）+ 相关 bun test 文件。B8 收尾后停下报告，等 Phase 2。
```

### Phase 2（frontend）
```
实施 docs/plan/2026-07-08-negotiation-learning-lifecycle/frontend.md（Phase 2，ui-v4「Learned」页面）。前置：Phase 1 已落地、/api/negotiation 契约见 backend.md B5/B7 与 README「冻结的 API 契约」。先读 frontend.md 全文 + README 的 Global Constraints。逐任务实施，前端测试用 jsdom+@testing-library/react（vitest），交付前必跑 `bun run build:ui`（rollup，非仅 vitest —— 见 skill debugging-frontend-tests）。类型经 ui-v4/src/types/index.ts 的 ~backend re-export，绝不前端重定义。每任务 pathspec 提交。
```

## 收尾（Phase 2 完成后，session-closeout）

① subagent 交付审计（code-reviewer + typescript-reviewer + react-reviewer，显式裁判轴：长远正确 + 完整）② doc-sync：更新 [docs/DESIGN.md](../../DESIGN.md)「活的架构现状」表加 negotiation-lifecycle 行 + 配置节加 `negotiation_learning`，跨文档 grep 验证 ③ 归档本 plan（头部实施状态注解）④ 提炼教训维护记忆库 ⑤ 细粒度阶段提交。

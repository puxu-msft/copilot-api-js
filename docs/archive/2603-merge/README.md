# 前后端统合方案：消除 `ui/history-v3/package.json`

## 目标

将 `ui/history-v3/` 从独立子项目（有自己的 `package.json`、`bun.lock`、`node_modules`）合并到根项目，
统一用根 `package.json` 管理所有依赖和脚本。

## 当前状态

**合并已完成。** `ui/history-v3/package.json` 和 `bun.lock` 已删除，所有依赖和脚本由根 `package.json` 统一管理。

| 维度 | 合并后 |
|------|--------|
| 包管理 | 根 `package.json`（npm）统一管理前后端依赖 |
| 构建 | 后端 `tsdown`，前端 `vite build --config ui/history-v3/vite.config.ts` |
| 类型检查 | 后端 `tsc`，前端 `vue-tsc --project ui/history-v3/tsconfig.json` |
| 测试 | 后端 `bun test tests/`，前端 `bun test ./ui/history-v3/tests/` |
| ESLint | `eslint.config.js` 统一覆盖前后端（含 `.vue` 文件） |
| 路径别名 | 后端 `~/*` → `src/*`，前端 `@/*` → `src/*`，`~backend/*` → `../../src/*` |

## 源代码改动

合并主要是包管理层面改动，但有两处必须的源码改动：

- `ui/history-v3/vite.config.ts` — 加 `root: __dirname`（Vite root 不会自动指向 config 目录）
- `ui/history-v3/tsconfig.json` — include 加 `tests/**/*.ts`（补齐类型检查覆盖面）

## 详细方案

1. [01-dependencies.md](01-dependencies.md) — 依赖合并 ✅
2. [02-scripts.md](02-scripts.md) — 脚本统一 ✅
3. [03-typescript.md](03-typescript.md) — TypeScript 配置 ✅
4. [04-vite.md](04-vite.md) — Vite 配置迁移 ✅
5. [05-eslint.md](05-eslint.md) — ESLint 覆盖范围扩展 ✅
6. [06-path-aliases.md](06-path-aliases.md) — 路径别名（保持不变） ✅
7. [07-migration-steps.md](07-migration-steps.md) — 分阶段执行计划 ✅
8. [08-risks.md](08-risks.md) — 风险与回退方案（所有项已解决）
9. [09-p2-cold-start-504.md](09-p2-cold-start-504.md) — P2：冷启动 504 ✅
10. [10-vue-router-v-slash.md](10-vue-router-v-slash.md) — P3：`/v/` 路径告警 ✅

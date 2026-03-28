# P2：vue-json-pretty 冷启动 504 (Outdated Optimize Dep)

**状态：已修复** ✅

## 现象

首次冷启动 `npm run dev:ui` 后访问 `#/v/history`，控制台出现：

- `Failed to load resource: 504 (Outdated Optimize Dep)` — 目标：`vue-json-pretty.js`

刷新后恢复正常，后续访问不再复现。

> **注意**：首次访问时可能同时看到 Vue Router 警告 `No match found for location with path "/v/"`。
> 该警告是独立的路由构造问题，与 504 无关，已拆分至 [10-vue-router-v-slash.md](10-vue-router-v-slash.md)。

## 根因分析

Vite dev 模式使用 **dependency pre-bundling**（esbuild 预构建 node_modules 依赖到 `.vite/deps/`）。
当预构建缓存失效但页面已加载旧的 import map 时，Vite 返回 504 表示"这个预构建产物已过期，请重新加载"。

迁移将 `vue-json-pretty` 从 `ui/history-v3/node_modules` 提升到根 `node_modules`，
改变了 Vite 预构建缓存的路径键，导致首次启动时缓存失效概率升高。

`vue-json-pretty` 在 `ToolUseBlock.vue` 和 `RawJsonModal.vue` 中是**静态导入**：

```ts
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'
```

但这两个组件所在的路由页面（`VHistoryPage.vue` 等）是通过 `() => import(...)` 懒加载的，
因此 `vue-json-pretty` 不在应用入口图的初始模块中。Vite 在 dev server 启动时不一定能在最早阶段完成对它的 optimize-deps，
需要在运行时首次命中该路由后才发现并触发重新预构建。

**不影响生产构建**：`manualChunks` 已显式将 `vue-json-pretty` 打入 `vendor` chunk。

## 修复内容

在 `ui/history-v3/vite.config.ts` 中添加了 `optimizeDeps.include`，
将三个延迟发现的依赖加入预构建列表：

```ts
optimizeDeps: {
  include: ["vue-json-pretty", "diff", "diff2html"],
},
```

## 验证

修复后，清除 `node_modules/.vite` 并冷启动 `npm run dev:ui`，首次访问 History 页不再出现 504。

> 合并前子项目缓存路径为 `ui/history-v3/node_modules/.vite`，合并后以根目录 `node_modules/.vite` 为准。

## 优先级

P2 — 仅影响 dev 模式首次冷启动，不影响生产构建和部署。

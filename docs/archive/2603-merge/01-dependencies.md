# 01 — 依赖合并

## 原则

- 根 `package.json` 成为唯一的依赖声明处
- 前端专用依赖标注清晰（通过注释分组）
- 重复依赖去重，保留较高版本

## 当前依赖对比

### 重复依赖

| 包 | 根版本 | 前端版本 | 处理 |
|----|--------|----------|------|
| vue | ^3.5.29 (devDep) | ^3.5.13 (dep) | 保留根版本 ^3.5.29，移至 dependencies |
| @playwright/test | ^1.58.2 | ^1.58.2 | 去重，保留一份在 devDep |
| typescript | ^5.9.3 | ~5.9.3 | 去重，保留 ^5.9.3 |

### 前端 dependencies → 根 dependencies

这些是前端运行时依赖，会被 Vite 打包进浏览器 bundle，但声明在根 `dependencies` 中不影响 tsdown 后端构建（tsdown 只打包 `src/main.ts` 的导入图）。

```
@mdi/font         ^7.4.47    → dependencies（Vuetify icon font）
diff               ^8.0.3     → dependencies
diff2html          ^3.4.56    → dependencies
vue                ^3.5.29    → dependencies（从 devDep 升格）
vue-json-pretty    ^2.6.0     → dependencies
vue-router         ^5.0.4     → dependencies
vuetify            ^4.0.4     → dependencies
```

### 前端 devDependencies → 根 devDependencies

```
@types/diff          ^7.0.0    → devDependencies
@vitejs/plugin-vue   ^6.0.4    → devDependencies
vite                 ^7.3.1    → devDependencies
vite-plugin-vuetify  ^2.1.3    → devDependencies
vue-tsc              ^3.2.5    → devDependencies
```

### 合并后的根 package.json dependencies 段

```jsonc
{
  "dependencies": {
    // --- Backend ---
    "@hono/node-ws": "^1.3.0",
    "citty": "^0.2.1",
    "consola": "^3.4.2",
    "fetch-event-stream": "^0.1.6",
    "gpt-tokenizer": "^3.4.0",
    "hono": "^4.12.3",
    "picocolors": "^1.1.1",
    "proxy-from-env": "^2.0.0",
    "socks": "^2.8.7",
    "tiny-invariant": "^1.3.3",
    "undici": "^7.22.0",
    "yaml": "^2.8.2",
    // --- Frontend (bundled by Vite, not included in backend build) ---
    "@mdi/font": "^7.4.47",
    "diff": "^8.0.3",
    "diff2html": "^3.4.56",
    "vue": "^3.5.29",
    "vue-json-pretty": "^2.6.0",
    "vue-router": "^5.0.4",
    "vuetify": "^4.0.4"
  },
  "devDependencies": {
    // ... 原有 devDependencies ...
    "@types/diff": "^7.0.0",
    "@vitejs/plugin-vue": "^6.0.4",
    "vite": "^7.3.1",
    "vite-plugin-vuetify": "^2.1.3",
    "vue-tsc": "^3.2.5"
    // 移除: vue（已升格至 dependencies）
  }
}
```

## 注意事项

1. **tsdown 不受影响**：tsdown 只分析 `src/main.ts` 的 import 图，不会把 vue/vuetify 打包进后端。
2. **npm publish 的 `files` 字段**已包含 `ui/history-v3/dist`，无需改动。
3. **`bun.lock` 删除**：合并后 `ui/history-v3/bun.lock` 不再需要，只保留根 `package-lock.json`。
4. **`ui/history-v3/node_modules` 删除**：所有依赖提升到根 `node_modules`。

## 验证记录

`ui/history-v3/package.json`、`bun.lock`、`node_modules/` 已全部删除。删除后重新验证了所有构建和测试命令（build:ui、build:backend、typecheck、typecheck:ui、test、test:ui），全部通过。`npm ls vue` 确认无版本重复（全部 deduped 到 3.5.29）。

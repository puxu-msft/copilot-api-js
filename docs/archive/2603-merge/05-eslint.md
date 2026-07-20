# 05 — ESLint 覆盖范围扩展

**状态：已完成** ✅

## 变更前状态

根 `eslint.config.js` 通过 `ignores: ["ui/**"]` 排除了整个前端目录。
前端没有独立的 ESLint 配置，也没有被 lint 过。

`@echristian/eslint-config@0.0.54` 不包含 `eslint-plugin-vue` 或 `vue-eslint-parser`，
无法解析 `.vue` 文件。

## 已实施的修改

### 1. 新增依赖

```
eslint-plugin-vue          — Vue SFC lint
@vue/eslint-config-typescript — Vue + TypeScript 集成（提供 defineConfigWithVueTs）
```

### 2. eslint.config.js 重构

- 包装函数从 `export default [...]` 改为 `defineConfigWithVueTs(...)`，启用 Vue + TS 联合解析
- `ignores` 从 `"ui/**"` 改为 `"ui/**/dist/**"`——只忽略构建产物，源码纳入 lint
- 新增 `.vue` 文件专用规则段：

  ```js
  {
    files: ["ui/**/*.vue"],
    extends: [pluginVue.configs["flat/essential"], vueTsConfigs.recommendedTypeChecked],
    rules: {
      "vue/multi-word-component-names": "off",
      // ... 前端特有的规则放宽
    },
  }
  ```

- 新增 JSON 文件段：禁用所有 `@typescript-eslint/*` 规则（避免 JSON 被 TS 规则误报）

### 3. lint-staged 扩展

```json
"*.{ts,js,mjs,cjs,vue}": "bun run lint"
```

`.vue` 文件纳入 pre-commit lint。

### 4. 测试规则处理

原方案建议为 `tests/**/*.ts` 和 `ui/**/tests/**/*.ts` 分别配置放宽段。
实际实施采用了不同策略：将 `@typescript-eslint/no-unsafe-*` 系列规则在全局关闭（因为本项目作为 API 代理大量处理动态 JSON payload，这些规则全局噪音过高），
测试文件和源码适用同一套规则，不再需要单独的测试放宽段。

## 备注

- Prettier 配置从内联改为引用 `prettier.config.mjs`
- 这是一次较大的 ESLint 配置重构，不仅仅是"移除 ignore"

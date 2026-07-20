# 02 — 脚本统一

## 当前脚本

### 根 package.json

```json
{
  "build": "npm run build:ui && npx tsdown",
  "build:ui": "cd ui/history-v3 && bun install && bun run build",
  "dev": "bun run --watch ./src/main.ts",
  "dev:ui": "cd ui/history-v3 && bun run dev",
  "test": "bun test tests/unit/",
  "test:ui": "cd ui/history-v3 && bun test tests/",
  "typecheck": "tsc"
}
```

### ui/history-v3/package.json

```json
{
  "build": "vue-tsc -b && vite build",
  "dev": "vite",
  "preview": "vite preview",
  "typecheck": "vue-tsc --noEmit"
}
```

## 合并后的脚本

**前提**：`ui/history-v3/vite.config.ts` 已显式设置 `root: __dirname`（见 [04-vite.md](04-vite.md)）。

```jsonc
{
  "scripts": {
    // --- Backend ---
    "build": "npm run build:ui && npx tsdown",
    "build:backend": "npx tsdown",
    "dev": "bun run --watch ./src/main.ts",
    "typecheck": "tsc",

    // --- Frontend ---
    "build:ui": "vite build --config ui/history-v3/vite.config.ts",
    "dev:ui": "vite --config ui/history-v3/vite.config.ts",
    "preview:ui": "vite preview --config ui/history-v3/vite.config.ts",
    "typecheck:ui": "vue-tsc --noEmit --project ui/history-v3/tsconfig.json",

    // --- Testing ---
    "test": "bun test tests/unit/",
    "test:all": "bun test tests/unit/ tests/component/ tests/contract/ tests/integration/ tests/e2e/",
    "test:ci": "bun test tests/unit/ tests/component/ tests/contract/ tests/integration/",
    "test:component": "bun test tests/component/",
    "test:contract": "bun test tests/contract/",
    "test:e2e": "bun test tests/e2e/",
    "test:integration": "bun test tests/integration/",
    "test:ui": "bun test ./ui/history-v3/tests/",
    "test:e2e-ui": "bunx playwright test",

    // --- Quality ---
    "knip": "knip-bun",
    "lint": "eslint --cache",
    "lint:all": "eslint --cache .",
    "start": "NODE_ENV=production bun run ./src/main.ts",

    // --- Release ---
    "prepack": "npm run build",
    "prepare": "npm run build && (command -v bun >/dev/null 2>&1 && simple-git-hooks || true)",
    "release": "bumpp && npm publish --access public"
  }
}
```

## 关键变化

| 脚本 | 变化 | 原因 |
|------|------|------|
| `build:ui` | 不再 `cd` + `bun install`，不再捆绑 vue-tsc | 依赖已在根目录安装；类型检查由 `typecheck:ui` 独立负责 |
| `dev:ui` | `vite --config ui/history-v3/vite.config.ts` | 从根目录启动，vite.config.ts 通过 `root: __dirname` 定位前端目录 |
| `typecheck:ui` | 新增，`vue-tsc --noEmit --project ...` | 前后端 tsconfig 不同，需要分开检查 |
| `test:ui` | `bun test ./ui/history-v3/tests/`（注意 `./` 前缀） | bun test 对非直接子目录路径需要 `./` 前缀才能识别为路径而非过滤器 |
| `preview:ui` | 新增，暴露原有的 vite preview | 方便 UI 预览 |

## 已验证的命令行行为

### Vite `--config` 不会自动设置 root

Vite 的 `root` 默认是 `process.cwd()`，`--config` 只影响配置文件查找路径。
从根目录运行 `vite build --config ui/history-v3/vite.config.ts` 时，
Vite 会在根目录找 `index.html`，导致报错 `Cannot resolve entry module "index.html"`。

**解决方案**：在 `vite.config.ts` 中显式设置 `root: __dirname`（见 [04-vite.md](04-vite.md)）。

### `vue-tsc -b` 和 `--project` 不能同时使用

TypeScript 的 `-b`（build mode）直接接 tsconfig 路径，不能搭配 `--project`：

```bash
# 错误 — TS5094: Compiler option '--project' may not be used with '--build'.
vue-tsc -b --project ui/history-v3/tsconfig.json

# 正确 — build mode 直接接路径
vue-tsc -b ui/history-v3/tsconfig.json

# 正确 — 非 build mode 用 --project
vue-tsc --noEmit --project ui/history-v3/tsconfig.json
```

本方案选择将构建和类型检查分离：`build:ui` 只负责 Vite 构建，`typecheck:ui` 独立负责类型检查。
CI 可自由决定两者的执行顺序。

### bun test 嵌套路径需要 `./` 前缀

```bash
# 错误 — 被当作过滤器，匹配 0 个文件
bun test ui/history-v3/tests/

# 正确 — ./  前缀让 bun 识别为路径
bun test ./ui/history-v3/tests/    # 159 pass
```

注意：顶层 `tests/unit/` 等路径不需要 `./`（bun 对直接子目录有特殊处理），
但嵌套路径（如 `ui/history-v3/tests/`）必须带 `./`。

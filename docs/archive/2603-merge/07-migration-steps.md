# 07 — 分步执行计划

## 前提

- 在新分支上操作（`feat/monorepo-merge`）
- 每一步完成后验证构建和测试

## Phase 1：配置修改

### Step 1：修改 vite.config.ts

在 `ui/history-v3/vite.config.ts` 中加 `root: __dirname`（见 [04-vite.md](04-vite.md)）。

这是必须先做的改动——后续所有从根目录调用 Vite 的脚本都依赖此设置。

### Step 2：扩展前端 tsconfig include

将 `ui/history-v3/tsconfig.json` 的 `include` 扩展为（见 [03-typescript.md](03-typescript.md)）：

```json
{
  "include": [
    "src/**/*.ts", "src/**/*.tsx", "src/**/*.vue",
    "tests/**/*.ts"
  ]
}
```

## Phase 2：依赖合并

### Step 3：合并依赖到根 package.json

1. 将前端 `dependencies` 和 `devDependencies` 加入根 `package.json`（见 [01-dependencies.md](01-dependencies.md)）
2. `vue` 从 devDependencies 移至 dependencies
3. 去重 `@playwright/test` 和 `typescript`
4. 在根目录运行 `npm install`
5. 验证 `node_modules` 中前端依赖存在：
   ```bash
   ls node_modules/vuetify node_modules/vue-router node_modules/@vitejs/plugin-vue
   ```

### Step 4：更新根脚本

更新根 `package.json` 的 scripts（见 [02-scripts.md](02-scripts.md)），关键变化：
- `build:ui`: `vite build --config ui/history-v3/vite.config.ts`
- `dev:ui`: `vite --config ui/history-v3/vite.config.ts`
- `typecheck:ui`: `vue-tsc --noEmit --project ui/history-v3/tsconfig.json`
- `test:ui`: `bun test ./ui/history-v3/tests/`（注意 `./` 前缀）

## Phase 3：验证（删除子项目 node_modules 之前）

此阶段先在子项目 node_modules 仍存在时验证，确认根脚本能正确定位配置和入口。

### Step 5：验证前端构建

```bash
npm run build:ui
ls ui/history-v3/dist/index.html
```

### Step 6：验证类型检查

```bash
npm run typecheck        # 后端
npm run typecheck:ui     # 前端
```

### Step 7：验证测试

```bash
npm run test             # 后端
npm run test:ui          # 前端（应 159 pass）
```

## Phase 4：删除子项目包管理并重新验证

**关键**：当前能跑不代表删掉子项目 node_modules 后也能跑。
必须在删除后重新验证所有命令。

### Step 8：删除子项目包管理残留

```bash
rm ui/history-v3/package.json
rm ui/history-v3/bun.lock
rm -rf ui/history-v3/node_modules/
```

### Step 9：重新完整验证

```bash
npm run build:ui                   # 前端构建
npm run build:backend              # 后端构建
npm run typecheck                  # 后端类型检查
npm run typecheck:ui               # 前端类型检查
npm run test                       # 后端测试
npm run test:ui                    # 前端测试
npm run build                      # 完整构建（前端 + 后端）
```

### Step 10：验证开发模式

```bash
npm run dev:ui
# 手动验证：打开浏览器访问 localhost:5173，确认页面正常、图标加载、样式正确
```

## Phase 5：更新文档

### Step 11：更新文档

1. `ui/history-v3/README.md` — 改为根脚本调用方式：
   ```bash
   npm run dev:ui        # 开发模式
   npm run build:ui      # 构建
   npm run preview:ui    # 预览构建产物
   npm run typecheck:ui  # 类型检查
   npm run test:ui       # 测试
   ```
2. `ui/history-v3/CLAUDE.md` — 移除 `bun install` 描述，更新构建命令
3. `CLAUDE.md` — 更新涉及前端构建的描述
4. `docs/DESIGN.md` — 更新前端子项目说明

## Phase 6（独立 PR）：ESLint 扩展

ESLint 覆盖前端文件需要先验证 shared config 对 Vue SFC 的支持情况，
不应与主迁移捆绑。见 [05-eslint.md](05-eslint.md)。

## 验证清单

- [x] `ui/history-v3/vite.config.ts` 已加 `root: __dirname`
- [x] `ui/history-v3/tsconfig.json` include 已加 `tests/**/*.ts`
- [x] `npm run build` — 完整构建（前端 + 后端）通过
- [x] `npm run build:ui` — 前端独立构建通过
- [x] `npm run build:backend` — 后端独立构建通过
- [x] `npm run typecheck` — 后端类型检查通过
- [x] `npm run typecheck:ui` — 前端类型检查通过
- [x] `npm run test` — 后端测试通过（677 pass）
- [x] `npm run test:ui` — 前端测试通过（159 pass）
- [x] `npm run dev:ui` — 主路由浏览器验收已完成（详见 [260327-1-test-report.md](260327-1-test-report.md)）；deeper interaction / realtime / production preview 未覆盖
- [x] `ui/history-v3/package.json` 已删除
- [x] `ui/history-v3/bun.lock` 已删除
- [x] `ui/history-v3/node_modules/` 已删除
- [x] `ui/history-v3/README.md` 已更新
- [x] `ui/history-v3/CLAUDE.md` 已更新
- [x] 以上验证项在删除子项目 node_modules **之后** 重新通过

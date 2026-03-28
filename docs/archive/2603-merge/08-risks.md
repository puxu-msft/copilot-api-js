# 08 — 风险与回退方案

## 已修正的阻塞问题（经验证）

以下问题已在方案文档中修正，列于此处作为记录：

| 问题 | 原方案写法 | 验证结果 | 修正 |
|------|-----------|----------|------|
| Vite root | `--config` 自动切换 root | 报错 `Cannot resolve entry module "index.html"` | 在 vite.config.ts 加 `root: __dirname` |
| vue-tsc 命令 | `vue-tsc -b --project path` | `TS5094: '--project' may not be used with '--build'` | build:ui 不捆绑 vue-tsc；typecheck:ui 用 `--noEmit --project` |
| bun test 路径 | `bun test ui/history-v3/tests/` | 被当作过滤器，0 匹配 | 加 `./` 前缀：`bun test ./ui/history-v3/tests/` |

## 兼容性风险（需在迁移中验证）

| 风险 | 影响 | 验证方法 | 缓解 |
|------|------|----------|------|
| 依赖版本冲突（vue 双版本） | 运行时行为异常 | `npm ls vue` 确认只有一个版本 | 合并前去重 |
| Vite 插件（vite-plugin-vuetify）假设 node_modules 在同级 | 插件报错 | 运行 `npm run build:ui` | Vuetify 插件使用标准 resolve，应无问题 |
| `@mdi/font` 的 CSS/字体文件解析 | 图标丢失 | 构建后检查 dist 中是否包含字体文件 | Vite 通过 import 解析，走 node_modules 查找链 |
| bun test 对 mock.module 的路径解析变化 | 前端测试中的 module mock 失败 | 运行 `npm run test:ui` | 前端测试使用相对路径 mock（`"../src/api/ws"`），不受根目录变化影响 |

## 非阻塞补强项

| 项目 | 状态 | 说明 |
|------|------|------|
| ~~前端 tsconfig include 测试目录~~ | 已完成 | `tests/**/*.ts` 已加入 include |
| ~~`ui/history-v3/README.md` 更新~~ | 已完成 | 已改为根脚本调用方式 |
| ~~ESLint 覆盖前端~~ | 已完成 | 引入 `eslint-plugin-vue` + `@vue/eslint-config-typescript`，详见 [05-eslint.md](05-eslint.md) |

## 验证记录

`ui/history-v3/package.json`、`bun.lock`、`node_modules/` 已全部删除。删除后重新验证了所有构建和测试命令，全部通过。

## 需要改动的文件

与原方案"不涉及任何源代码修改"的说法不同，实际需要改动以下文件：

| 文件 | 改动 | 原因 |
|------|------|------|
| `ui/history-v3/vite.config.ts` | 加 `root: __dirname` | Vite root 不会自动指向 config 目录 |
| `ui/history-v3/tsconfig.json` | include 加 `tests/**/*.ts` | 补齐前端类型检查覆盖面 |

以下文件不需要改动：
- `ui/history-v3/src/` 下的所有源代码（.vue, .ts, .css）
- `ui/history-v3/index.html`
- 根 `tsconfig.json`
- 根 `tsdown.config.ts`
- 后端所有源代码
- 所有测试文件

## 回退方案

整个合并主要是包管理层面改动，源代码改动极少（vite.config.ts 加一行、tsconfig 扩展 include）。
回退成本低：

```bash
# 恢复 ui/history-v3/package.json（从 git）
git checkout HEAD -- ui/history-v3/package.json

# 恢复 vite.config.ts 和 tsconfig.json（如果已改动）
git checkout HEAD -- ui/history-v3/vite.config.ts ui/history-v3/tsconfig.json

# 恢复前端 node_modules
cd ui/history-v3 && bun install

# 恢复根 package.json
git checkout HEAD -- package.json
npm install
```

tsdown 不会打包 vue 等前端依赖（只跟踪 `src/main.ts` 的导入图），
npm publish 的 `files` 字段只包含 `dist` 和 `ui/history-v3/dist`，体积不受影响。

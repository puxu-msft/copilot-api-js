# 编码与架构约定

CLAUDE.md 放原则；本文件放可查阅的事实性约定。

## 代码风格

- `@echristian/eslint-config` + Prettier，运行 `eslint --fix` 自动格式化（**不要**直接 `prettier --write`）。
- 不用分号；三元运算符放行首。
- Prettier `printWidth = 160`。超宽不缩短/扭曲代码——调 printWidth 或 `// prettier-ignore`。
- 严格 TS（`strict: true`），避免 `any`；ESNext 模块，不用 CommonJS。
- 错误处理用显式错误类（`src/lib/error/`），避免静默失败。
- 同目录文件互导用相对 `./foo`，跨域用别名：后端 `~/*`→`src/*`，前端 `@/*`→`ui/src/*`，前端引后端 `~backend/*`→`../src/*`。

## 注释规范

`/** */`（JSDoc，产文档/悬停）：模块顶部、所有 export、接口字段、重要非导出声明。
`//`（实现细节，不产文档）：分隔线、barrel 分组标签、函数体逻辑、TODO/FIXME、行内短注。
二者不混用。

## 测试组织

后端测试在 `tests/`，两维度：功能域目录镜像 `src/lib/`（anthropic/openai/responses/models/history/config/pipeline/shutdown/infra…）+ 隔离后缀（`.unit` 纯函数 / `.it` 起 runtime / `.http` 起 app）。`e2e/`（需 token）、`e2e-ui/`（Playwright）单列；前端在 `ui/tests/`。需 runtime 的 `.it`/`.http` 默认调 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`。新增 module-global 单例须给 `reset*ForTests` 并登记 `RESETTERS`。

## 依赖选型 bun-first

Bun 一等公民，Node 仅兼容目标。外部库须 Bun 原生可跑，拒 node-gyp 绑定。命令走 `bun run`（非 `npm run`）。

详见 DESIGN.md「运行时兼容」「测试组织」与 spec/test-env-isolation.md。

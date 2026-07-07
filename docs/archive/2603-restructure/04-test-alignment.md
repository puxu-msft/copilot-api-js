# 04 — 测试可追踪性与入口对齐（P1）— 已完成

## 目标

不是“每个源文件一个同名测试文件”（本项目使用 unit/component/integration/e2e 分层测试，不适用镜像策略），
而是同时做到两件事：

1. 从测试文件名能快速判断它测试的是什么模块、功能或页面
2. 从测试命令能快速判断它会由哪个 runner 执行、覆盖哪一层

## 已完成

### 1. 命名误导最明显的测试文件已修正

| 测试文件 | 实际 import 的模块 | 结论 |
|----------|-------------------|------|
| `system-prompt-config-integration.test.ts` | `~/lib/config/config` + `~/lib/system-prompt` | 已按真实覆盖范围命名 |
| `copilot-api.test.ts` | `~/lib/copilot-api` | 已与源文件模块名对齐 |
| `server-tool-rewriting.test.ts` | `~/lib/anthropic/message-tools` + `~/lib/anthropic/server-tool-filter` | 仍为功能集成测试，名称可接受 |

### 2. Playwright 浏览器 E2E 已与 Bun 测试发现彻底分离

| 项目 | 调整 | 目的 |
|------|------|------|
| `tests/e2e-ui/*.spec.ts` | 重命名为 `*.pw.ts` | 避免被 `bun test` 误发现并以错误 runner 执行 |
| `playwright.config.ts` | 增加 `testMatch: /.*\\.pw\\.ts/` | 明确声明 Playwright 只管理浏览器 E2E 文件 |
| `tests/e2e-ui/helpers.ts` | 抽取 `BASE_URL`、`ensureServerRunning()`、`uiUrl()` | 消除页面级 E2E 的重复入口逻辑 |

### 3. package scripts 已能表达测试分层

当前测试入口语义：

| 命令 | 覆盖范围 |
|------|----------|
| `npm test` | unit |
| `npm run test:backend` | unit + component + contract + integration + backend e2e |
| `npm run test:ui` | 前端单测 |
| `npm run test:e2e-ui` | Playwright 浏览器 E2E（需外部运行中的服务） |
| `npm run test:e2e-ui:local` | 指向 `http://localhost:4141` 的本地浏览器 E2E |
| `npm run test:all` | backend + 前端单测 |
| `npm run test:acceptance` | backend + 前端单测 + 浏览器 E2E 的完整验收入口 |

## 不需要继续调整的点

### 功能点命名的测试文件

这些文件虽然不与源文件一一同名，但按职责仍然清晰：

| 文件 | 理由 |
|------|------|
| `dedup-tool-calls.test.ts` | 指向 sanitize 的去重子功能 |
| `strip-read-tool-result-tags.test.ts` | 指向 sanitize 的标签剥离子功能 |
| `message-sanitizer.test.ts` | “message sanitizer”是 sanitize 模块的常见称呼 |
| `response-utils.test.ts` | 单函数测试，保持即可 |

### `anthropic/sanitize.ts` 的分散覆盖

`anthropic/sanitize.ts` 的行为仍分散在多个测试文件里：
- `message-sanitizer.test.ts` — 主管道
- `dedup-tool-calls.test.ts` — 去重子功能
- `strip-read-tool-result-tags.test.ts` — 标签剥离子功能
- 部分 component test 也覆盖 sanitize 行为

这不需要因为 04 强行合并。按功能点分测试是合理的，只要后续 01 的拆分继续保持可追踪即可。

## 当前结论

- 04 不再只是“重命名两个文件”
- 真实完成内容是：命名对齐、runner 边界清理、浏览器 E2E 公共入口抽取、脚本语义澄清
- 现在 `bun test`、`npm run test:ui`、`npm run test:e2e-ui` 各自的职责边界已经清楚

## 验证

- [x] `bun test` 通过
- [x] `npm run test:all` 通过
- [x] `npm run test:ui` 通过
- [x] `npm run test:e2e-ui` 可由 Playwright 单独执行
- [x] `bun test` 不再误执行 Playwright 浏览器 E2E
- [x] 测试文件名与测试命令都能快速反映覆盖范围

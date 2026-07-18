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

第三方 I/O adapter 和 durability 协议必须按真相域分层：

1. 真实 backend contract 锁定单位、默认值、callback、rotation 和 runtime 行为。
2. 受控 fake 的 primitive unit 锁状态机与顺序。
3. 业务 sink integration 锁映射。
4. Production facade integration 锁接线。
5. 涉及信号或退出时用真实子进程或 PTY。

禁止用一个 wall-clock 测试跨层证明全部行为。任何“rotation / exactly-once / production wired / flush completed”断言先用正样本证明目标路径确实触发；exactly-once 用计数多重集，不用会折叠重复的 `Set`。诊断文件域详见 skill `diagnostic-durability`。

复杂持久化或生命周期改动开始前，先把冻结 spec/plan 与代码做 inventory，逐项标记 `present / missing / misplaced`；再写 producer ownership、durable unit、commit point、crash-before/after-commit、retry、corrupt、concurrent shutdown failure matrix。计划承诺的核心模块缺失时，应先补架构，不得在最近的 consumer 内打补丁。

## 依赖选型 bun-first

Bun 一等公民，Node 仅兼容目标。外部库须 Bun 原生可跑，拒 node-gyp 绑定。命令走 `bun run`（非 `npm run`）。

**决策背景与备选方案见 [decisions/2026-07-05-dependency-selection-bun-first.md](decisions/2026-07-05-dependency-selection-bun-first.md)（权威 ADR，真正的用户决策）**；实现分流见 DESIGN.md「运行时兼容」「测试组织」与 spec/test-env-isolation.md。

## 诊断日志与终端输出

- 新代码优先使用 scoped `DiagnosticLogger`，字段以 richest structured form 进入 `DiagnosticEvent`；consola 仅是存量兼容 adapter，禁止在新代码里把对象预先 `JSON.stringify` 成 message。
- canonical 边界固定为 snapshot/project→recursive redact→deep-freeze→publish。token、device/user code、authorization/cookie/password/secret 不得进入 message/error/fields；需显式展示的一次性 credential 只走 `SensitiveOutputPort.writeOnce()`。
- 服务模式 stdout 只能由 `OutputArbiter` 写，stderr 只能由 `EmergencyOutput` 兜底。render leaves 只返回 trusted ANSI frame；所有外部字符串先过 terminal sanitizer。
- 长期文件日志只有 per-process NDJSON。目录/manifest/spool/segment 归属与 durability 由 `src/lib/diagnostics/file/` 管理；不得重新引入 shared active file 或自行实现第二套 rotation。

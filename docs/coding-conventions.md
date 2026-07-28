# 编码与架构约定

CLAUDE.md 放原则；本文件放可查阅的事实性约定。

## 代码风格

- `@echristian/eslint-config` + Prettier，运行 `eslint --fix` 自动格式化（**不要**直接 `prettier --write`）。
- 不用分号；三元运算符放行首。
- Prettier `printWidth = 160`。超宽不缩短/扭曲代码——调 printWidth 或 `// prettier-ignore`。
- 严格 TS（`strict: true`），避免 `any`；ESNext 模块，不用 CommonJS。
- 错误处理用显式错误类（`src/lib/error/`），避免静默失败。
- 同目录文件互导用相对 `./foo`，跨域用别名：后端 `~/*`→`src/*`，前端 `@/*`→`ui/src/*`，前端引后端 `~backend/*`→`../src/*`。

## 发射与识别是两条轴（emit-closed / accept-open）

凡是**我方产出、之后又要认回来**的标识物（wire 上的合成哨兵、配置键、协议载体版本），配置面按两条轴拆，**形状相反**：

- **发射轴（主动用什么）= 封闭枚举**。只放已被证实可用的取值。开放成自由字符串，用户就能填出一个自伤值（例：分隔符填纯空白 → 上游 strip 掉 → 自造那个本来要修的 400）。
- **识别轴（额外承认什么）= 开放列表**。扩大识别面是**单调**的：只会把更多东西归类为"我方产出"，永远不可能造出非法输出。历史值、第三方部署留下的值、迁移期的新旧并存，全靠这条轴。

收益是**迁移与回滚都变成零成本**：新版发射 v2 的同时继续认 v1；回滚不会把已经流到对端的标识物变成认不出的垃圾。识别比较用**整体 trim 后全等**，不做子串匹配（否则正常内容里提到该字面量就被误认），空值永远不算。

项目内实例：配置键的 `compat.ts`（发新键、认旧键）；`assistant_block_layout_strategy` 的 `separator_carrier`（封闭）/ `separator_accept_extra`（开放），见 [spec/2026-07-26-thinking-terminal-block-layout.md](spec/2026-07-26-thinking-terminal-block-layout.md)。

## 配置读留在装配层，别下沉进叶子

纯逻辑叶子（如 `src/lib/anthropic/sanitize/*` 的契约模块）**不要 import `state`**。本仓 `state` 处在一个 19 模块的巨型 SCC 里，叶子一旦读它就被整个吸进去——`tests/architecture/circular-deps-ratchet.unit.test.ts` 会立刻转红（实测踩过）。

正确形状：**配置读留在本来就在 SCC 内的装配层**（`sanitize/index.ts`、driver/strategy 等调用点），把解析结果**作为参数向下传**给纯叶子。副作用是叶子天然可测（不需要 `setStateForTests`）。

## 注释规范

`/** */`（JSDoc，产文档/悬停）：模块顶部、所有 export、接口字段、重要非导出声明。
`//`（实现细节，不产文档）：分隔线、barrel 分组标签、函数体逻辑、TODO/FIXME、行内短注。
二者不混用。

## 测试组织

后端测试在 `tests/`，两维度：功能域目录镜像 `src/lib/`（anthropic/openai/responses/models/history/config/pipeline/shutdown/infra…）+ 隔离后缀（`.unit` 纯函数 / `.it` 起 runtime / `.http` 起 app）。`e2e/`（需 token）单列；前端在 `ui/tests/`，含浏览器 e2e（Playwright，`.pw.ts`）——2026-07-22 起 UI 外置，主包 `tests/e2e-ui/` 已迁入 `ui/tests/e2e/`（`ui-v4/` 尚无等价 Playwright 套件）。需 runtime 的 `.it`/`.http` 默认调 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`。**前端测试（`ui/`、`ui-v4/`）必须显式单独触发**（`test:ui` / `test:ui-v4` / `test:e2e-ui`），任何后端档位脚本都不得聚合它们（2026-07-27 用户决定，守卫在 `tests/infra/test-discovery-matrix.unit.test.ts`）。新增 module-global 单例须给 `reset*ForTests` 并登记 `RESETTERS`。

**后缀=真相域（type）与档位（tier）是两条轴。** 后缀 `{unit, it, http, pty, e2e}` 是**真相域**（测什么、怎么隔离），**绝不按速度命名**。档位是「按速度分组」，纯靠 package.json 脚本按后缀组合表达（tier = type→档位的映射，脚本 key off 文件名）：**快速档 `test`（=`test:fast`）= unit+http**（每次改动即跑）、`test:backend` = unit+it+http（pre-push 全后端）、`test:it`/`test:pty`/`test:e2e` 按需、`test:ci` = backend+pty+e2e。默认 `bun run test` 只是**快速反馈、不是全后端验证**——doc/plan 里表达「全量/提交前全绿/commit invariant」语义处一律写 `bun run test:backend`。**改名 `.unit → .it` 的唯一充分条件是独立实测确认真相域确为集成（做真 I/O/spawn/起服务）；慢只是触发复核的信号、绝不作改名理由**（慢的纯单元留 unit + 注释，如 `request-payload.unit` 的 tokenizer 说明）。**history-search 的 native 产物默认不构建**（2026-07-28）：`native/history-search/*.node` 是 gitignored 构建产物，`bun install`（`prepare`→`build`）与各测试档位脚本**都不再强制构建它**——否则没有 Rust toolchain 的机器连 `bun install` 都过不去，而任何新建 worktree 里也天然没有该产物。依赖它的测试改为 `describe.skipIf(!isNativeHistorySearchAvailable())`：**有产物就真跑、没有就显式 skip，绝不红**（环境性的红太容易被当成「既有失败」挥手放过——2026-07-28 就发生过一次）。想真跑先 `bun run build:history-search`；`test:ci` 会自己先构建，保证这批测试不会烂掉。

L1 守卫 `tests/infra/test-discovery-matrix.unit.test.ts` 枚举全仓 `*.test.ts` 断言各带恰一个后缀且不在 `src/`（`bunfig root=./tests` 会隐藏 src 下测试），结构性防「已分档但无脚本运行」的孤儿。分档设计见 [spec/2026-07-14-test-tiering-by-speed.md](spec/2026-07-14-test-tiering-by-speed.md)。

**并行执行（均衡分片 runner）。** `test:fast`/`test:backend` 走 `scripts/parallel-test.ts`：按 committed per-file 耗时缓存（`scripts/test-timings.json`，`bun run test:timings` 刷新、缺失文件回退中位数）LPT 均衡分 `nproc` 桶、每桶单进程 `bun test`（片内共享模块缓存、只导入一次）、并行跑、聚合失败并正确退出码。实测 fast 档 **~5.5s**（vs `bun test --parallel` 12s）。**为何不用 `bun test --parallel`**：它强制 `--isolate`（每文件独立模块上下文），把重 `~/lib/*` 图**重导入 ~440 次**、wall 被重导入主导；分片让每桶只导入一次。**权衡**：片内文件共享 module-global，泄漏测试可能污染桶友（fixture 的 `RESETTERS`+`resetTestRuntime` 仍逐测隔离，只失进程级 isolate）——**查污染用 `test:fast:isolated`/`test:backend:isolated`**（`bun test --parallel`、每文件独立进程、防污染但慢）。retry backoff 等待经 `abortableDelay` 的延迟缩放 seam（isolated-fixture `beforeEach` 设 scale=0）在测试下瞬时 resolve（声明 waitMs/queueWaitMs 账目不变）。**pty 与 e2e 不并行**：pty 抢终端资源、e2e 触发真 GHC 限流。CI 分片另有 `bun test --shard=1/N`。

第三方 I/O adapter 和 durability 协议必须按真相域分层：

1. 真实 backend contract 锁定单位、默认值、callback、rotation 和 runtime 行为。
2. 受控 fake 的 primitive unit 锁状态机与顺序。
3. 业务 sink integration 锁映射。
4. Production facade integration 锁接线。
5. 涉及信号或退出时用真实子进程或 PTY。

禁止用一个 wall-clock 测试跨层证明全部行为。任何“rotation / exactly-once / production wired / flush completed”断言先用正样本证明目标路径确实触发；exactly-once 用计数多重集，不用会折叠重复的 `Set`。诊断文件域详见 skill `diagnostic-durability`。

### 守卫要挡住**等价绕过形态**，不只挡字面量

写"只有拥有者模块能碰这个标识"这类结构守卫时，光禁字面量不够——`import` 那个常量再自己 `===` 比较，是完全等价的绕过，而且正是真实代码里出现过的写法。守卫要把**两种形态一起禁**，并用旧代码做正样本对照（把旧写法塞回去，守卫必须转红）。

### 遍历全仓的结构守卫要给**显式时间预算**

解析全部生产源文件的守卫（包边界、包面、环 ratchet 之类）本就逼近 bun 默认的 5s 单测超时，仓库多几个文件或与其它分片并行跑就会假红。给它显式预算（`}, 30_000)`，对齐 `circular-deps-ratchet`），**不要为了压进默认超时去缩小扫描面**——扫描面正是这类守卫的价值所在。

## 实现前门禁

复杂持久化或生命周期改动开始前，先把冻结 spec/plan 与代码做 inventory，逐项标记 `present / missing / misplaced`；再写 producer ownership、durable unit、commit point、crash-before/after-commit、retry、corrupt、concurrent shutdown failure matrix。计划承诺的核心模块缺失时，应先补架构，不得在最近的 consumer 内打补丁。

## 依赖选型 bun-first

Bun 一等公民，Node 仅兼容目标。外部库须 Bun 原生可跑，拒 node-gyp 绑定。命令走 `bun run`（非 `npm run`）。

**决策背景与备选方案见 [decisions/2026-07-05-dependency-selection-bun-first.md](decisions/2026-07-05-dependency-selection-bun-first.md)（权威 ADR，真正的用户决策）**；实现分流见 DESIGN.md「运行时兼容」「测试组织」与 spec/test-env-isolation.md。

## 诊断日志与终端输出

- 新代码优先使用 scoped `DiagnosticLogger`，字段以 richest structured form 进入 `DiagnosticEvent`；consola 仅是存量兼容 adapter，禁止在新代码里把对象预先 `JSON.stringify` 成 message。
- canonical 边界固定为 snapshot/project→recursive redact→deep-freeze→publish。token、device/user code、authorization/cookie/password/secret 不得进入 message/error/fields；需显式展示的一次性 credential 只走 `SensitiveOutputPort.writeOnce()`。
- 服务模式 stdout 只能由 `OutputArbiter` 写，stderr 只能由 `EmergencyOutput` 兜底。render leaves 只返回 trusted ANSI frame；所有外部字符串先过 terminal sanitizer。
- 长期文件日志只有 per-process NDJSON。目录/manifest/spool/segment 归属与 durability 由 `src/lib/diagnostics/file/` 管理；不得重新引入 shared active file 或自行实现第二套 rotation。

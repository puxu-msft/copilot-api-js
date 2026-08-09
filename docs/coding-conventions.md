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
- **识别轴（额外承认什么）= 开放列表**。扩大识别面在 **wire 合法性**上是单调的：多认几个值只会把更多东西归类为"我方产出"，不可能让我们发出非法载荷。历史值、第三方部署留下的值、迁移期的新旧并存，全靠这条轴。
  **但"单调"只说集合，不等于语义安全**：识别结果往往喂给**破坏性消费者**——本仓 `isSyntheticThinkingSeparator()` 的下游就是 `stripAllThinking()` 的删除判据（`src/lib/anthropic/strip-all-thinking.ts` 的 `isStrippableBlock`），认下一个与真实用户文本会撞的值，等于授权删掉那段真内容。所以开放轴上每加一个值都必须是**明确、抗碰撞的**历史/第三方标识，加之前先查清全部消费者里有没有破坏性的那种。

收益是**迁移与回滚的成本大幅下降**（不是零：发射轴的枚举与 `config.yaml` 里 pin 的值仍要改）：新版发射 v2 的同时继续认 v1；回滚不会把已经流到对端的标识物变成认不出的垃圾。比较形状分两种，别混：**用户配置的额外值与 legacy 字面量走整体 trim 后全等**（否则正常内容里提到该字面量就被误删）；**我方自己的内置载体可以走带封闭命名空间的前缀族**（`text.startsWith("[copilot-api:thinking-separator")`，让旧版本认得出未来版本的载体）。空值永远不算。

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

**tally 的真相源是 JUnit XML + 文件身份完整性，两者缺一不可**（2026-08-09）。每个桶带 junit reporter 写一份 `shard-NN.xml`，pass/fail 由 `parseJUnit` 统计 `<failure>`／`<error>` 得出，pass 由 `executed - failed` 派生。**为什么不能读 stdout**：shard 在打印 summary 的过程中死掉时，`N fail` 那行永远不落，而失败的 testcase 行早已 flush 进 XML——按 stdout 统计就会在一条真失败之上打印绿色的 `0 fail`，同时把总数少报（实测一次：`3337 tests · 3337 pass · 0 fail`，而 junit 是 7529 executed、其中 1 条超时失败；原件在 `exp/junit-tally-false-green/`）。

⚠️ **但 JUnit 计数只是「已观察到的量」，不等于「总量」。** 测试文件在**加载期抛错**时根本不产生任何 JUnit 行，而 bun 照样打印自己的 `N fail`（实测 bun 1.3.14：summary `1 pass / 1 fail / 1 error / 2 files`，XML 却是 `tests=1 failures=0` 且完全不含该文件）——于是连 crash 分类器也不触发。兜住这一层的是 **discovery↔runtime 的文件身份对账**（`compareFileIdentities`）：发现集合里少了谁就退出 1，并在 tally 行打出 `⚠ INCOMPLETE: N file(s) produced no JUnit rows`。

**tally 数字的引用政策（本节是唯一定义处，别处只留指针）。** 这条政策是六轮独立评审收窄出来的，形状很重要：**它不是一条「满足 X 就可信」的充分判据，而是限定你能主张到什么强度**——前四轮我反复去找那条充分判据（先「无 `INCOMPLETE` 标记」、再「退出码 0」），每一条都被更窄的反例推翻，**别再去找第五条**。

| 允许主张 | 条件 |
|---|---|
| 「该次运行**观察到** N 个用例通过、0 个失败」 | 退出码 0 **且**引用时带上 commit、命令与原始 tally 行 |
| 「这次运行没有触发任何已实现的失真门」 | 同上（就是退出码 0 的含义） |

| **不得**主张 | 为什么 |
|---|---|
| 「共 N 个用例」「全量总数是 N」 | 计数是**已观察量**，不是总量——加载期抛错的文件一行不写 |
| 「用例数没有减少」「规模是 N」 | 增减类结论需要独立的完整性 oracle，退出码给不了 |

**退出码 0 是必要条件，不是充分条件。** 它的含义是「当前已实现的三道门都没触发」，而这三道门都是**部分**覆盖：① `parseJUnit` 用文档**自己声明的** `tests`／`failures`／`skipped` 与解析结果对账，不一致就抛错——挡的是「**我方 parser** 丢行或误计」（实测 16/16 份真实产物三项全等，三臂各有独立负控）；**产出方不声明这三个属性时该门不生效**，且它**不独立于 producer**（详见下方警告）；② discovery↔runtime 文件身份对账，两个方向各配一个标记：`⚠ INCOMPLETE`（请求的文件没出现在 artifact 的 identity 集合里 ⇒ 数字是**下界**）与 `⚠ OUT-OF-SCOPE`（未被请求的文件却出现了 ⇒ 数字**超出**预期集合）；③ shard 非零退出却没打出 `N fail` 摘要时判定为 mid-bucket crash，把该桶用 `--isolate` 重跑定位。

要把「观察量」升级成「总量」，**必须另外有一个能独立枚举目标成员的 oracle**。注意「独立」的判据是**追溯到不同的上游**，不是「换一种运行方式」。按能判到什么，分三层：

1. **「每个请求的文件有没有在 artifact 里被提及」——可判（这就是全部）。** 门 ② 拿 `discover()` 的结果同时做 child 的 `bun test` argv 与期望集，再与 JUnit 回报的 file identity 集合比较（`scripts/parallel-test.ts` 的 `const files = discover()` 一处两用）。**它证明的严格只是「集合相等」**：每个 requested path 至少出现在某个 `<testsuite file>` 或 `<testcase file>` 里。**它不证明**该文件启动了、模块加载成功了、或写出了任何 testcase row——一个只有 `<testsuite file="…"/>`、零 testcase 的空壳同样满足它（实跑：`parseJUnit` 对它得 `files:[…], executed:0`，随后 identity 比较为 `missing:[], unexpected:[]`）。要判「真的跑起来了」，得另找能观察模块执行的来源，**不能从 identity 回声反推**。
2. **「仓库里应该有哪些测试文件」——只有部分独立的交叉绊线。** 提交进仓库的发现基线（`tests/infra/entry-test-discovery-baseline.json`）**不参与生产门**——它只在收尾取证时由 `capture-entry-evidence.ts` 对账。且它**由同一个 checkout、同一套后缀集、同形 `Bun.Glob` 生成与校验**，与 runner 的 discovery **共享上游**。它挡的是「基线随时间漂移」，**不是结构独立的 oracle**——若 discovery 规则本身系统性漏掉某类文件，该文件既不进期望集、也不进 argv、也不进 JUnit，门 ② 照绿。
3. **「本应存在哪些 testcase」——不可判。** 没有任何东西独立枚举它；声明属性与行都出自同一份产物。**用例级总量至今不可判，这是已知缺口，不是待补的措辞。**

⚠️ **门 ① 的「声明计数对账」也不是独立 oracle。** 根属性与 testcase 行同出一个 Bun JUnit producer、同一份 artifact，所以它是 **producer 内部的自洽检查**：独立于**我方 parser 的计数实现**（能抓到我们丢行），**不独立于 producer**——producer 若把某文件从行与声明里一起省掉（加载期抛错正是如此），两侧一致、该门照过。

⚠️ **「同一 commit 连跑 N 次数字一致」同样不是完整性 oracle**——它与 tally 同源，三次可以稳定漏掉同一个文件，只能检出**随机漂移**、检不出**系统性缺失**。

（**这一节被独立评审连续三轮各证伪一次「独立性」**：先是 N-run、再是「基线与 runtime 独立」、再是「声明计数是独立 oracle」。三次都是同一个错误形态——判独立性要问**各自最终追溯到谁**，不是问它们看起来有多不一样。**这里现在没有任何一个独立完整性 oracle，别再找第四个。**）

实现新的报告器时同理：**只解析 XML 而不做上述对账，就会把加载期失败算成不存在**。

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

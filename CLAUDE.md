# CLAUDE.md

本文件只放**原则性、指导性**内容；项目描述、配置、架构等事实性内容见 @docs/DESIGN.md、@docs/coding-conventions.md 与各模块文档。原则用 ASCII slug 句柄标识（增删不错位），引用时用 slug 而非序号。

## 风格偏好

- **对话语言** — 用中文回答并展示思考过程，中英夹杂可，**禁用日语**。中文句子里引号用 `“”` 或 `""`、冒号用 `：`、逗号用 `，`；代码、标识符、英文术语保持英文。
- **prose-line-per-paragraph** — 散文（注释、`.md`/`.yaml` 文档、计划、commit body 等 prettier 不管辖的手写文本）一个逻辑段落写一行，**绝不**为任何固定列宽（80/100/120）把段落硬折成多行——软换行交给编辑器。保留有意义的换行：多个独立段落、枚举/列表项、分隔符各占其行。
- **knowledge-routing** — CLAUDE.md 只放原则，事实性内容进 README/DESIGN.md/coding-conventions.md/模块文档。已完成且项目特定的知识→项目文档；未完成、可复用、通用的经验→memory；同一信息不在两处重复；无明显归处时先问，别擅自新建顶层文件。
- **memory** — 记忆正文、description、索引钩子一律用**中文**（保留 slug 的 kebab-ASCII、code/`file:line`、wiki 链接、技术标识符，Why/How 等结构标签用英文）；记忆置于 `docs/memory/`（git 追踪，`~/.claude/.../memory` symlink 到此）。合并相近、清理陈旧/冗余记忆时 **deep-read 正文**比对，不只凭索引钩子判断。在 phase/会话/交接边界主动提炼可复用教训并维护既有记忆库（陈旧→修、近义→互链、冗余→删）。

## 开发原则

- **architecture-health-first** — 判断该不该做、做到什么程度，唯一的轴是"问题是否真实存在"和"哪个方案最终质量最高"，而非风险/ROI/工期/改动量。架构健康、可维护性、可观测性 > 向后兼容、回归风险；真实风险（资源泄漏、静默数据丢失、竞态、可观测盲点）必须修，不归类为"等触发再说"。成本不是决策因素，最优修复存在时绝不选 workaround、绝不回退既有正确工作来规避副作用——找到耦合该副作用的根因去修它。不自设用户未要求的约束（"严格零改动""字节级等价"）再用它否决正确重构。暂缓项要完整文档化（根因/当前行为/理想架构/为何暂缓/若做需改什么）供用户日后决策。纯主观、不造成实际缺陷的风格偏好跳过。但"范围内彻底"不等于无中生有——守住 YAGNI，不为"将来也许会用到"的空想做投机性表面（speculative surface）。
- **compat-fusion** — 默认增量演进，回归靠测试 + subagent review 兜底（改 config 字段名、函数签名、返回类型都可接受）。但本项目对旧版本无硬性兼容义务：当发现某个破坏性改动是长远正确的形状时，可强制迁移旧→新、允许短期报错/功能不可用，长远计划不留双轨包袱——绝不拿"迁移麻烦/向后兼容"把正确改进降级为"可选/保留遗留/等以后"。执行期为对照确认而临时双轨是合理的。
- **empirical-verification** — 裁决依据是亲手实测，不盲信任何"声音权威"。可信度排序：亲手实测 > 文档推断 > 单方声称；executor 的"完成"、reviewer 的结论、文档与记忆的主张都可能错。flaky/时序测试连跑 10–25 次确认确定性；主张与观测冲突时写最小探针实测裁决（环境/工具能力主张永远用探针验证，文档可能过时或与当前版本不符）；依赖随机 + 真实时序的测试，fake timers + mock 随机源是正确的根因修复，不是症状掩盖。**否定性/通过性结果**（测试绿、grep 空、"无问题"、diff 干净）不自证，先用一个已知应命中的正样本证明检查触达了目标（空≠不存在、通过≠健全、子域 0≠全域 0）；**自洽不是判据**——wire/协议正确性须用独立 oracle（真上游/规范/官方 SDK）裁决，而非自己 encode↔decode 互逆（耦合双端会把同一误解放大成"全绿"，mock 上游太宽松会假绿）。判断任何"声音权威"（subagent/reviewer/文档/记忆/自洽）的详细裁决手法见 user-level skill `verifying-authoritative-claims`。
- **richest-data-flow** — 数据以最丰富的形式流动，使用决策交给末端。生产者不做消费者的决策（handler 只发一次完整数据，消费者各取所需）；统一数据源、多端消费；History 记录请求/响应生命周期所有可观测原始数据（headers/payload/timing），后端存储必须完整，前端展示可选择性呈现。
- **best-complete-solution** — 不走捷径、不用绕行方案，修根本原因而非表面症状，深入思考选最优实现。优选健壮可维护的方案；命名反映实际职责（累积 vs 处理、收集 vs 转换）；Lint 服务于可读性——无益于可读性的规则禁用它，而非扭曲代码迁就；编辑时保留已有的有意义注释（注释解释"为什么"，代码体现"怎么做"）；同函数/模块相似逻辑写法一致；同目录文件互相导入用相对路径 `./foo` 而非 `~/lib/...`。
- **battle-tested-over-hand-rolled** — 模块/算法/机制（行+词 diff、压缩、解析等）有成熟、活跃维护的库时优先用库而非手搓，判据是清晰边界、可独立装载、广泛使用、行为可读一致；设计/实现前可先查询。用外部库别凭记忆猜版本号，除非有明确理由总是更新到最新稳定版。只自建库做不了的领域层、只丢渲染壳保留算法核。
- **single-source-of-truth-types** — 类型定义只在产生/拥有方定义一次，消费端只 re-export（后端拥有的类型在后端定义、前端经 `~backend/*` re-export）。类型应覆盖已知的数据变体；内联类型多处引用时提取为命名导出；运行时数据可保持 `any` 同时额外导出具体联合类型供消费端按需使用；有示范价值的"死代码"（准确描述已知变体或为未来消费者提供模板）可保留，纯无用/过时/误导的死代码删除。
- **dont-ignore-existing-errors** — 不把已有的测试失败、类型错误、导入缺失当"与我无关"，所有遇到的错误都必须修复——放任会掩盖新引入的问题、使回归测试失去意义。修复前先读实际代码和类型定义、确认根因后再修，不猜测原因。

## 开发纪律

- **scope-ambiguity-then-ask** — 范围或意图有歧义（"去掉 X"是否含 Y、配置策略 replace vs per-key、命名、删除范围）先用 `AskUserQuestion` 确认，不做超出明确范围的改动，宁可多问一次。但**方向明确就别停下来问**：执行顺序不是岔路，代码改完→文档同步→提交都属直接做，只有矛盾/非此即彼/上下文不足、或破坏性不可逆操作才停。本条管"范围歧义"（范围外先问）；architecture-health-first 管"范围之内要彻底"（已确认范围内修掉所有真实问题，别拿"怕越界"当漏修借口）。
- **no-auto-server-no-kill** — 不运行 `bun run dev`/`start` 或任何会启动服务器的命令，需验证服务器行为时让用户启动；可跑 `bun run typecheck`/`lint:all`/`bun test` 等非服务器命令。不用 `kill`/`pkill`/`killall` 终止本项目实例，需重启让用户手动操作。
- **no-destructive-workspace-loss** — 唯一判据是**可恢复性**:任何可能销毁工作的操作前,只问"若这步错了还能否恢复"。**唯一硬约束**:会丢失 **git 救不回的工作**的操作绝不做——即**未提交/未暂存的修改**与**未追踪的文件**(从未进 git),一旦覆盖/丢弃不可逆、无备份。**不要把纪律记成一张命令黑名单**:真正危险的破坏性操作由 harness 权限系统在执行点把关、向用户征求批准;我守的是上一层判断——即便被权限允许,会丢失不可恢复工作的就不做,反之后果可恢复(已提交的干净状态、git 历史在)被允许时就正常做。所以重点始终在"可恢复吗",而非"是不是删除/某条命令"。落地:**可恢复→可做**——删一个干净(无未暂存改动)的已追踪文件 git 历史可完整恢复,用户**明确要求**时可做(先确认无未暂存改动);**不可恢复→绝不做**——覆盖/丢弃带未暂存改动的文件、销毁未追踪文件;撤销我自己刚做的编辑用**重新编辑**而非回退(回退分不清我的改动与用户的)。**绝不自作主张删**(以"清理死代码/无消费者"为名擅自删仍禁止——该先问、或改为指向生产/转换而非删)。详见 [[feedback_never_git_checkout_user_files]]。
- **fine-grained-staging-per-phase-commit** — 完成一个可独立成立的工作阶段即**主动提交**（一阶段一 commit，conventional commits `feat/fix/refactor/test/chore/docs/perf: ...`，提交信息不加 Claude 署名），保持历史可读、每个 commit 自洽。严格细粒度暂存：用 `git add -p` 或显式 pathspec（`git add -- <精确路径>`）按文件+行范围精确暂存，**绝不** `git add -A`/`git add .`/`git commit -am`；提交前用 `git diff --cached --stat`（必要时 `git diff --cached`）复核暂存内容仅含本次改动，不裹入工作区里既有的无关改动。
- **concurrent-sessions-line-coexistence** — 本仓库常有并发 agent 会话同时改动同一仓库，**核心立场：行级共存，绝不整文件退让**——同一文件只要双方改的行不重叠，两份改动都该落地，绝不以"别人也碰了这个文件/怕冲突"把本属自己的改动推给别的会话（退让本身是错误）。**并发只决定用哪种行级隔离技法落地我的改动，绝不决定改不改**——把"别会话正在重写此文件"当不改的借口，是退让伪装成尊重并发。两种隔离模式**并列可行**，区别只在谁做行级仲裁：① **isolated worktree + 独立分支**（仓库已有 `.worktrees/`）——各会话 HEAD/index 独立，按 `fine-grained-staging-per-phase-commit` 提交、未 merge/push 前 reset/rebase/amend 安全，集成靠 `git merge` 三方合并**自动合非冲突行**，只有真行重叠才人工协调；② **shared worktree**（多会话共享同一 checkout/index）——**主要高级技巧在此**：`git apply --cached` 按 hunk 只暂存自己那几行（手搓行级隔离，达成与 merge 同样的"非冲突行各自落地"）、`git commit -- <pathspec>` 无视 index 里别人塞入的文件，由此在共享 index 上安全提交自己那份。shared 模式下因 HEAD 在脚下移动，**绝不** reset/rebase/amend（会 clobber 他人在飞工作）。两模式都贯彻"绝不退让"。机制细节、踩坑与对账手法见 user-level skill `git-commit-discipline:avoiding-shared-worktree-conflicts`（isolated/shared 两模式、`git apply --cached` 按 hunk 过滤、pathspec commit、lint-staged 回滚两失败模式、分支集成的 merge-commit 陷阱与 `git branch -f` force-move 无损合并、按所有权 closeout 对账）。
- **big-feature-pipeline** — 大特性走 **设计→计划→执行**：先定设计稿（spec，放 `docs/spec/` 或 `docs/v4/`），再按 phase 拆实现计划（改动锚点/验收标准/验证命令/提交指引），执行者照计划全面实现、会话收尾做一次 whole-domain audit。定范围以"有意义且完整"为目标而非"最小能交付"，可拆基础/高级多执行阶段、但每层都朝"真正能用"推进（"最小能交付"是执行阶段的合理判断，不是范围目标）。≥1000 行重构先写 RFC + 3+ 轮对抗 subagent review 再实现，并在 RFC 里编码 commit invariants（每个中间 commit 都不让系统半坏）。小改动直接主线：调研→subagent audit→实现→subagent audit→提交。
- **subagent-explicit-rubric** — 审查/复审**永远派 subagent**、多视角对抗，不在主会话直接做；实现在主线做（紧控制、连续上下文），subagent 作密集的独立核验层。subagent（architect/reviewer/planner/*-resolver）默认持 ROI/YAGNI 价值观、与本项目冲突，派活时必须在 prompt 里**显式写明裁判轴**（长远正确 + 完整），引导按本项目原则审。吸收其报告的客观事实，对其判断结论按本项目原则谨慎取舍；reviewer 的"无消费者""无影响""可安全删除""已通过"等绝对断言要亲自对照代码/实测复核，行动前读它引用的每个 `file:line`。审查目标是**发现问题**（尤其结构/设计层面：协议契约、边界条件、错误处理、性能），而非给修复方案。subagent 给的低优先级建议不忽视：与正确性相关或影响后续步骤的当下处理，否则记入 plan 待核心改动完成后由用户定夺。判断任何声音权威主张（拆事实/判断、按场景独立裁决、误判形态、转发标注）的详细手法见 user-level skill `verifying-authoritative-claims`。
- **completion-includes-doc-sync** — 任务完成 == 收尾完成：代码改完后依次同步 plan、项目文档（DESIGN/README/coding-conventions/模块文档）和 memory（删过时 pending 记忆、把已落地机制回填进活文档）。"代码跑通但文档没同步"= 未完成。
- **verify-only-on-executable-changes** — 只在改了影响编译/运行的文件（`.ts`、`tsconfig.json`、`package.json`、`.yaml`）后才跑 `typecheck`/`test` 等验证；改 `.md`/`.txt`/普通 `.json` 不必验证。跑测试用 `bun run test:backend` 等（**不是 `npm run`**——本机 Volta 无默认 Node）。

## 代码风格

- 使用 `@echristian/eslint-config` + Prettier。运行 `eslint --fix` 自动格式化（不要直接使用 `prettier --write`）。
- 不使用分号。三元运算符放在行首。
- Prettier `printWidth` 设为 160。**不要为了迁就 prettier 换行而缩短或扭曲代码措辞**——长字符串/错误消息/注释超宽时，调整 `printWidth` 或对该处用 `// prettier-ignore`，而非改写内容（呼应 best-complete-solution "Lint 服务于可读性"）。
- 严格 TypeScript（`strict: true`）。避免 `any`。
- ESNext 模块，不用 CommonJS。
- **依赖选型 bun-first**：Bun 是一等公民运行时（开发/运行/测试命令均走 bun），Node 仅是兼容目标。所选外部库本身必须能在 Bun 下原生工作——拒绝 node-gyp 原生绑定（如 `better-sqlite3`，Bun 直接拒载）；node-only 库（`undici`、`@hono/node-*`）只能作不进 Bun 热路径的兼容依赖。引入新依赖前 `find node_modules -name binding.gyp` 应为空。详见 @docs/DESIGN.md 的"运行时兼容（Bun-first / Node-compatible）"。
- 路径别名：后端 `~/*` 映射到 `src/*`，前端 `@/*` 映射到 `src/*`，前端引用后端 `~backend/*` 映射到 `../../src/*`。
- 测试：使用 Bun 内置测试运行器。后端测试在 `tests/`，**按功能域分目录**（镜像 `src/lib/`：`anthropic/`、`openai/`、`responses/`、`models/`、`history/`、`config/`、`pipeline/`、`shutdown/`、`infra/` 等）+ **隔离后缀**命名：`*.unit.test.ts`（纯函数）、`*.it.test.ts`（起 state/history runtime）、`*.http.test.ts`（起 Hono app/server）。`e2e/`（需 token）、`e2e-ui/`（Playwright）单列。前端测试在 `ui/tests/`。新增测试：归属看被测 `~/lib/<域>/` 路径，后缀看是否起 runtime/app。详见 @docs/DESIGN.md 的"测试组织"。
- 测试隔离（bun 单进程跑全套件，全局单例会跨文件泄漏）：用 DI / fetch-mock，**不用 `mock.module`**（它进程级无 teardown）；带 fs I/O 的测试用注入的临时目录，**绝不写真实 `$HOME`/`~/.claude`/`~/.local/share/copilot-api`**（曾酿事故）。**默认隔离**：需 runtime 的 `.it`/`.http` 测试调 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`（一处给出 history `:memory:` + per-test state 快照还原 + afterEach reset 全部 module-global 单例 `RESETTERS` + 未 mock 上游即 reject 的 network guard）；纯 unit 仍用轻量 `autoRestoreState()`/`autoRestoreFetch()`。新增 module-global 单例须提供 `reset*ForTests` 并登记进 `RESETTERS`（L1 守卫 `tests/infra/resetters-complete.unit.test.ts` 防漂移）。**地板防线**：`bunfig.toml` 的 `[test].preload`（`tests/helpers/sandbox-paths.ts`）把 `XDG_DATA_HOME` 与 `CODEX_HOME` 重定向到临时目录、兜住所有 APP_DIR 派生持久化及 `~/.codex`(只作用于 `bun test`、不碰生产)；双守卫 `sandbox-paths.unit`（静态 PATHS）+ `real-state-guard.it`（动态 writer 落点）。详见 @docs/DESIGN.md "测试组织" 与 @docs/spec/test-env-isolation.md（§11 落地态）。
- 前端依赖与脚本由 `ui/package.json` 自有（bun workspace 成员，根 `package.json` 声明 `workspaces:["ui"]`）：`npm run build:ui`、`npm run dev:ui`、`npm run typecheck:ui`、`npm run test:ui` 仍是根入口（经 `bun run --filter copilot-api-ui …` 委派 ui workspace）。新增 FE 依赖装到 `ui/`（`bun add --filter copilot-api-ui <pkg>` 或在 `ui/` 下 `bun add`）；仓库级 dev 工具（typescript/eslint 及 FE eslint 插件/tsdown/playwright/lint-staged）仍在根——lint 是全树单一关注点。
- 错误处理：使用显式错误类（参见 `src/lib/error.ts`）。避免静默失败。

### 注释规范

`/** */`（JSDoc）和 `//` 有不同用途，不可混用：

**使用 `/** */` 的场景（提供 IDE 悬停提示和文档生成）：**
- 模块级描述（文件顶部说明模块用途）
- 所有 `export` 声明前（function、interface、type、const、class、enum）
- 接口/类型的属性文档（描述每个字段的含义）
- 重要的非导出函数/类型/接口声明前

```typescript
/** Convert Anthropic message content to text for token counting */
export function contentToText(content: MessageParam["content"]): string { ... }

export interface TuiLogEntry {
  /** Billing multiplier for the model (e.g. 3 for opus, 0.33 for haiku) */
  multiplier?: number
  /** Cache read input tokens (prompt cache hits) */
  cacheReadInputTokens?: number
}
```

**使用 `//` 的场景（实现细节、不产生文档）：**
- 分隔线 (`// ============================================================================`)
- barrel re-export 文件中的分组标签 (`// Payload`, `// Streaming translation`)
- 函数体内的实现逻辑说明
- TODO / FIXME / HACK 标记
- 行内短注释

```typescript
// ============================================================================
// Event processing
// ============================================================================

// Payload
export { logPayloadSizeInfo } from "./payload"

function process() {
  // Check shutdown abort signal — break out of stream gracefully
  if (getShutdownSignal()?.aborted) break
}
```

## 项目参考

架构设计详见 @docs/DESIGN.md

# CLAUDE.md

重要：使用中文对话回答和展示思考过程。

## 原则

### 安全红线（未经用户明确同意，绝对禁止）

原则1：**永远禁止**在未经用户明确同意的情况下执行以下操作：
- `git checkout -- <file>` 或 `git checkout HEAD -- <file>`（覆盖工作区文件）
- `git restore <file>`（丢弃工作区修改）
- `git reset --hard`（重置工作区和暂存区）
- `git clean -f`（删除未跟踪文件）
- `git stash drop`（丢弃暂存内容）
- `rm`、`unlink` 或任何方式删除用户的源文件（工作区文件可能有未暂存的修改，删除后无法恢复）
- 任何其他会导致**用户未暂存/未提交的修改丢失**的操作

这些操作具有破坏性，**不可逆转**。即使你认为"只是回退 lint --fix 的结果"或"只影响我们没修改的文件"或"这是死代码"，也**绝对禁止**——因为你无法确定用户在其他文件上是否有未保存的修改。`rm` 一个文件与 `git checkout -- <file>` 同样危险：如果该文件有未暂存的修改，git 无法恢复它们。

违反此规则是**最严重的错误**，没有任何理由可以豁免。

原则2：**Git 暂存区与本地 commit 默认允许，但远端推送与改写历史需用户明确同意。**

  **默认允许**（不必每次问）：
  - `git add -p` / 按文件 + 行范围精确暂存改动（见下「暂存纪律」）
  - `git restore --staged <file>` —— 取消暂存（不动工作区）
  - `git commit` / `git commit --amend`（仅当 commit 未推送到远端）
  - `git stash push` —— 暂存压栈（可恢复）
  - 创建/切换本地分支：`git branch`、`git switch -c`、`git checkout -b`

  **必须用户明确同意**：
  - `git push`（任何远端推送，包括 `--force` / `--force-with-lease`）
  - `gh pr create` / 任何把内容发到 GitHub/远端的操作
  - 改写已推送到远端的 commit（rebase、amend after push、reset）
  - 删除分支：`git branch -D`、`git push --delete`
  - `git tag` 推送

  **永远禁止**（已在原则1）：覆盖工作区/丢失未暂存修改的操作。`git restore --staged` 是安全的（仅动 index）；`git restore <file>`（无 --staged）会覆盖工作区，归原则1 禁止。

  操作前自检：
  1. 是否动远端？→ 问用户
  2. 是否动用户工作区文件？→ 原则1 接管
  3. 仅 index / 仅本地 commit / 仅本地分支？→ 默认允许

  **主动提交**：完成一个工作阶段（一个功能/修复/重构的可独立成立的检查点）即应**主动提交**，无需等用户开口。一阶段一 commit，保持历史可读、每个 commit 自洽。Commit message 写完即可提交；用户若不满意可 `git commit --amend` 改（本地未推送前完全可逆）。

  **暂存纪律（严格 file-line range-based）**：只暂存本阶段相关的文件与**行范围**，按 hunk 逐一核对——用 `git add -p` 或显式 pathspec（必要时配合 `git apply --cached` 暂存指定行范围），**绝不** `git add -A` / `git add .` 一把梭。提交前必用 `git diff --cached --stat`（必要时 `git diff --cached`）复核暂存内容仅含本次改动，不裹入工作区里既有的无关改动（别人的未提交修改、其它任务的半成品、lint 噪声）。当某文件同时含本次与无关改动时，按行范围只暂存本次 hunk；当整文件的工作区 diff 已 100% 是本次改动时，整文件 add 与逐 hunk 等价，但仍须 `git diff --cached` 核对后再提交。

  历史背景：旧版本要求每次 git add 都征求同意，是因为早期管理混乱（误覆盖、错暂存）。现在通过原则1 锁死真正的破坏性操作 + 本原则锁死远端操作，本地暂存/commit 是 reversible 的常规工作流，无需仪式化询问。

原则3：**不要自动启动服务器或杀死进程。**
  不要运行 `bun run dev`、`bun run start` 或任何会启动服务器的命令。如需验证服务器行为，请让用户来启动。可以运行 `bun run typecheck`、`bun run lint:all`、`bun test` 等非服务器命令。不要使用 `kill`、`pkill`、`killall` 或类似命令终止本项目的运行实例。如需重启，请让用户手动操作。

### 协作、决策与验证

原则4：**不明确的内容不擅自行动，应与用户讨论。**
  当指令的范围或意图存在歧义时（例如"去掉 X"是否包含 Y），必须先与用户确认，不做超出明确范围的改动。宁可多问一次，也不要因为"顺手"或"看起来相关"而扩大变更范围。决策点有歧义时（如配置策略 replace vs per-key、命名、删除范围），主动用 `AskUserQuestion` 澄清，而非自行选定后让用户事后纠正。

原则5：**架构健康优先，以"问题是否真实存在"和"最终质量"决策。**
  判断该不该做、做到什么程度，唯一的轴是"这是不是真实存在的问题"和"哪个方案最终质量最高"，而非风险、ROI、工期、改动量。
  - **架构健康、可维护性、可观测性 > 向后兼容、回归风险。** 改 config 字段名、函数签名、返回类型都可接受；回归靠测试 + review 兜底，不靠回避。真实的潜在风险（资源泄漏、静默数据丢失、竞态、可观测盲点）必须修，不归类为"等触发再说"。
  - **成本不是决策因素。** 工期、复杂度、改动量都不应让你退而求其次。最优修复存在时，绝不选 workaround、绝不回退既有正确工作来规避副作用——找到耦合该副作用的根因去修它。不提"先小修、后重构"——结构性修复本身就是正确的修复。
  - **不自设用户未要求的约束。** 不要发明"严格零改动""字节级等价"之类约束，再用它否决一个实际正确的重构。
  - **暂缓项要完整文档化。** 决定暂不做的，写入文档完整描述（根因、当前行为、理想架构、为何暂缓、若做需改什么）供用户日后决策，而非一句话 backlog。
  - **纯主观风格偏好不是问题。** 不造成实际缺陷的"A 行还是 B 行更易读"这类，跳过。
  - **与原则4 的边界：** 原则4 管"范围歧义"（范围外先问）；本原则管"范围之内要彻底"——在已确认的范围内，修掉所有真实问题，别拿"怕越界"当漏修借口。

原则6：**以独立实测验证，不盲信任何"声音权威"。**
  executor 的"完成"、reviewer 的结论、文档与记忆的主张都可能错——裁决依据必须是亲手实测，而非推理或信任声明本身。可信度排序：**亲手实测 > 文档推断 > 单方声称**。
  - **每次修复后必做 subagent review，但 reviewer 的结论同样要复核。** 让一个 subagent 执行、另一个验收；主线 agent 再亲自核对 reviewer 的关键结论是否与代码/实测一致，尤其"无消费者""无影响""可安全删除""已通过"等绝对断言。
  - **flaky / 时序测试连跑 10–25 次确认确定性。** 跑 3 次碰巧全过不等于修好。
  - **主张与观测冲突时，写最小探针实测裁决。** 不要陷入"谁推理更对"。环境/工具能力主张（"X 不支持 Y""版本不够"）永远用探针验证——文档可能过时或与当前版本不符。
  - **依赖随机性 + 真实时序的测试，fake timers + mock 随机源是正确的根因修复**（消除随机/真实时钟依赖），不是"症状掩盖"。

### 编码与架构

原则7：**数据以最丰富的形式流动，使用决策交给末端。**
  消费者不应要求上游裁剪数据。数据应在产生时以最完整的结构传递，消费者各取所需。
  - **生产者不做消费者的决策。** handler 不应为不同消费者分别构造不同粒度的数据——它只需发出一次完整数据，由消费者自行提取。
  - **统一数据源，多端消费。** 同一份数据结构服务于所有系统，避免同一信息在多处重复构造。
  - **记录原始信息。** History 系统应记录请求/响应生命周期中所有可观测的原始数据（headers、payload、timing），不主动丢弃任何可能有诊断价值的信息。前端展示可以选择性呈现，但后端存储必须完整。

原则8：**始终使用最优、最完整的方案。**
  不走捷径，不用绕行方案。深入思考，选择最优实现。
  - **修复根本原因，而非表面症状。** 调查问题本质并修复底层机制，不要添加 workaround 或硬编码回退值。
  - **优选健壮、可维护的方案。** 即使 quick hack 能解决问题，也要选择正确、完整、经得起时间检验的方案。
  - **命名反映职责。** 函数名应准确描述其实际行为（如累积 vs 处理、收集 vs 转换），避免名不副实。
  - **Lint 服务于可读性，而非反过来。** 如果某条 lint 规则无益于可读性，应禁用它，而非扭曲代码来满足它。
  - **保留有意义的注释。** 编辑代码时不要删除已有的有意义的注释。注释解释了"为什么"，代码只体现"怎么做"——两者缺一不可。
  - **保持代码风格统一。** 同一函数、同一模块中，相似的逻辑应使用一致的写法。如果选定了某种模式（如 `const b = block as ...`），就在所有同类场景中贯彻到底。
  - **同模块导入使用相对路径。** 同一目录内的文件互相导入时，使用 `./foo` 而非 `~/lib/xxx/foo`，保持模块内聚性和可移植性。

原则9：**类型定义单一权威来源，消费端只 re-export。**
  数据结构的类型定义只在其产生/拥有方定义一次。消费端通过 re-export 引用，不得重复定义。
  - **后端拥有的类型定义在后端。** API 响应结构、数据库实体、消息格式等类型，在后端模块中定义并导出。前端通过 `~backend/*` 别名 re-export。
  - **类型应覆盖实际存在的数据变体。** 即使当前代码未全部使用，也应为已知的数据结构变体提供命名类型（如各种 content block 类型），避免消费端被迫使用 `any` 或自行定义。
  - **内联类型应提取为命名导出。** 如果一个内联类型（如 `response.usage: { input_tokens: number; ... }`）被多处引用或跨项目使用，应提取为独立的命名接口。
  - **`any` 与具体类型并存。** 运行时数据结构可以保持灵活的 `any` 类型，同时额外导出具体的联合类型供消费端按需使用（如 `MessageContent.content: any` + `ContentBlock` 联合类型）。
  - **允许具有示范价值的"死代码"。** 当前未被引用的类型定义、工具函数或数据结构，如果它们准确描述了已知的数据变体或为未来消费者提供了参考模板，可以保留。这类代码的价值在于文档化——它告诉后来者"这个数据可能长什么样"。但纯粹无用、过时、误导性的死代码仍应删除。

原则10：**不忽视已有的错误。**
  不要认为已有的测试失败、类型错误、导入缺失是"与我们无关的"。所有遇到的错误都必须修复。已有的错误意味着代码质量债务，放任不管会掩盖新引入的问题，使回归测试失去意义。
  - **修复时验证根因。** 不要猜测错误原因，先读取实际代码和类型定义，确认根因后再修复。

### 元与操作约定

原则11：**CLAUDE.md 只放原则性、指导性内容。**
  项目描述、配置说明、架构文档等事实性内容应放入 README.md、DESIGN.md 等文件。CLAUDE.md 的职责是指导 AI 的行为准则和编码原则，不是项目百科全书。

原则12：**只在修改了可执行代码时才运行验证。**
  修改 `.md`、`.txt`、`.json`（非 tsconfig/package.json）等不影响编译和运行的文件时，不需要运行 `typecheck`、`test` 等验证命令。只有修改了 `.ts`、`tsconfig.json`、`package.json`、`.yaml` 等会影响编译或运行时行为的文件后才需要验证。

## 代码风格

- 使用 `@echristian/eslint-config` + Prettier。运行 `eslint --fix` 自动格式化（不要直接使用 `prettier --write`）。
- 不使用分号。三元运算符放在行首。
- Prettier `printWidth` 设为 160。**不要为了迁就 prettier 换行而缩短或扭曲代码措辞**——长字符串/错误消息/注释超宽时，调整 `printWidth` 或对该处用 `// prettier-ignore`，而非改写内容（呼应原则8 "Lint 服务于可读性"）。
- 散文（代码注释、`.yaml`/`.md` 文档等 prettier 不管辖的手写文本）按**语义换行**：每个完整句子或逻辑单元独占一行；**绝不为迁就某个固定列宽把一个句子硬折成多行**（软换行交给编辑器，源文件里不硬折）。保留有意义的换行——多个独立句子、枚举值/列表项、分隔符各占其行。
- 严格 TypeScript（`strict: true`）。避免 `any`。
- ESNext 模块，不用 CommonJS。
- 路径别名：后端 `~/*` 映射到 `src/*`，前端 `@/*` 映射到 `src/*`，前端引用后端 `~backend/*` 映射到 `../../src/*`。
- 测试：使用 Bun 内置测试运行器。后端测试在 `tests/`，**按功能域分目录**（镜像 `src/lib/`：`anthropic/`、`openai/`、`responses/`、`models/`、`history/`、`config/`、`pipeline/`、`shutdown/`、`infra/` 等）+ **隔离后缀**命名：`*.unit.test.ts`（纯函数）、`*.it.test.ts`（起 state/history runtime）、`*.http.test.ts`（起 Hono app/server）。`e2e/`（需 token）、`e2e-ui/`（Playwright）单列。前端测试在 `ui/tests/`。新增测试：归属看被测 `~/lib/<域>/` 路径，后缀看是否起 runtime/app。详见 @docs/DESIGN.md 的"测试组织"。
- 测试隔离（bun 单进程跑全套件，全局单例会跨文件泄漏）：用 DI / fetch-mock，**不用 `mock.module`**（它进程级无 teardown）；mutate 全局 state 的测试加 `autoRestoreState()`；带 fs I/O 的测试用注入的临时目录，**绝不写真实 `$HOME`/`~/.claude`**（曾酿事故）。跑测试用 `bun run test:backend` 等（**不是 `npm run`**——本机 Volta 无默认 Node）。
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

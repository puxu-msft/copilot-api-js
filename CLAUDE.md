# CLAUDE.md

重要：使用中文对话回答和展示思考过程。

## 原则

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

原则2：**禁止**在未经用户明确同意的情况下修改 Git 暂存区（暂存或取消暂存）。
  除非用户明确要求提交，否则不要运行 `git add`、`git reset`、`git restore --staged` 或任何修改 git 暂存区的命令。所有暂存决策交给用户。

原则3：**数据以最丰富的形式流动，使用决策交给末端。**
  消费者不应要求上游裁剪数据。数据应在产生时以最完整的结构传递，消费者各取所需。
  - **生产者不做消费者的决策。** handler 不应为不同消费者分别构造不同粒度的数据——它只需发出一次完整数据，由消费者自行提取。
  - **统一数据源，多端消费。** 同一份数据结构服务于所有系统，避免同一信息在多处重复构造。

原则4：**始终使用最优、最完整的方案。**
  不走捷径，不用绕行方案。深入思考，选择最优实现。
  - **修复根本原因，而非表面症状。** 调查问题本质并修复底层机制，不要添加 workaround 或硬编码回退值。
  - **优选健壮、可维护的方案。** 即使 quick hack 能解决问题，也要选择正确、完整、经得起时间检验的方案。
  - **命名反映职责。** 函数名应准确描述其实际行为（如累积 vs 处理、收集 vs 转换），避免名不副实。
  - **Lint 服务于可读性，而非反过来。** 如果某条 lint 规则无益于可读性，应禁用它，而非扭曲代码来满足它。
  - **保留有意义的注释。** 编辑代码时不要删除已有的有意义的注释。注释解释了"为什么"，代码只体现"怎么做"——两者缺一不可。
  - **保持代码风格统一。** 同一函数、同一模块中，相似的逻辑应使用一致的写法。如果选定了某种模式（如 `const b = block as ...`），就在所有同类场景中贯彻到底。
  - **同模块导入使用相对路径。** 同一目录内的文件互相导入时，使用 `./foo` 而非 `~/lib/xxx/foo`，保持模块内聚性和可移植性。

原则5：**类型定义单一权威来源，消费端只 re-export。**
  数据结构的类型定义只在其产生/拥有方定义一次。消费端通过 re-export 引用，不得重复定义。
  - **后端拥有的类型定义在后端。** API 响应结构、数据库实体、消息格式等类型，在后端模块中定义并导出。前端通过 `~backend/*` 别名 re-export。
  - **类型应覆盖实际存在的数据变体。** 即使当前代码未全部使用，也应为已知的数据结构变体提供命名类型（如各种 content block 类型），避免消费端被迫使用 `any` 或自行定义。
  - **内联类型应提取为命名导出。** 如果一个内联类型（如 `response.usage: { input_tokens: number; ... }`）被多处引用或跨项目使用，应提取为独立的命名接口。
  - **`any` 与具体类型并存。** 运行时数据结构可以保持灵活的 `any` 类型，同时额外导出具体的联合类型供消费端按需使用（如 `MessageContent.content: any` + `ContentBlock` 联合类型）。
  - **允许具有示范价值的"死代码"。** 当前未被引用的类型定义、工具函数或数据结构，如果它们准确描述了已知的数据变体或为未来消费者提供了参考模板，可以保留。这类代码的价值在于文档化——它告诉后来者"这个数据可能长什么样"。但纯粹无用、过时、误导性的死代码仍应删除。

原则6：**不忽视已有的错误。**
  不要认为已有的测试失败、类型错误、导入缺失是"与我们无关的"。所有遇到的错误都必须修复。已有的错误意味着代码质量债务，放任不管会掩盖新引入的问题，使回归测试失去意义。
  - **修复时验证根因。** 不要猜测错误原因，先读取实际代码和类型定义，确认根因后再修复。

原则7：**不要自动启动服务器或杀死进程。**
  不要运行 `bun run dev`、`bun run start` 或任何会启动服务器的命令。如需验证服务器行为，请让用户来启动。可以运行 `bun run typecheck`、`bun run lint:all`、`bun test` 等非服务器命令。不要使用 `kill`、`pkill`、`killall` 或类似命令终止本项目的运行实例。如需重启，请让用户手动操作。

原则8：**CLAUDE.md 只放原则性、指导性内容。**
  项目描述、配置说明、架构文档等事实性内容应放入 README.md、DESIGN.md 等文件。CLAUDE.md 的职责是指导 AI 的行为准则和编码原则，不是项目百科全书。

原则9：**只在修改了可执行代码时才运行验证。**
  修改 `.md`、`.txt`、`.json`（非 tsconfig/package.json）等不影响编译和运行的文件时，不需要运行 `typecheck`、`test` 等验证命令。只有修改了 `.ts`、`tsconfig.json`、`package.json`、`.yaml` 等会影响编译或运行时行为的文件后才需要验证。

## 代码风格

- 使用 `@echristian/eslint-config` + Prettier。运行 `eslint --fix` 自动格式化（不要直接使用 `prettier --write`）。
- 不使用分号。三元运算符放在行首。
- 严格 TypeScript（`strict: true`）。避免 `any`。
- ESNext 模块，不用 CommonJS。
- 路径别名：后端 `~/*` 映射到 `src/*`，前端 `@/*` 映射到 `src/*`，前端引用后端 `~backend/*` 映射到 `../../src/*`。
- 测试：使用 Bun 内置测试运行器。后端测试放在 `tests/`，前端测试放在 `ui/history-v3/tests/`。命名为 `*.test.ts`。
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

架构设计详见 @DESIGN.md

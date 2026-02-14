# CLAUDE.md

重要：使用中文对话回答和展示思考过程。

## 原则

原则1：**永远禁止**在未经用户明确同意的情况下执行以下 Git 操作：
- `git checkout -- <file>` 或 `git checkout HEAD -- <file>`（覆盖工作区文件）
- `git restore <file>`（丢弃工作区修改）
- `git reset --hard`（重置工作区和暂存区）
- `git clean -f`（删除未跟踪文件）
- `git stash drop`（丢弃暂存内容）
- 任何其他会导致**用户未暂存/未提交的修改丢失**的操作

这些操作具有破坏性，**不可逆转**。即使你认为"只是回退 lint --fix 的结果"或"只影响我们没修改的文件"，也**绝对禁止**——因为你无法确定用户在其他文件上是否有未保存的修改。

违反此规则是**最严重的错误**，没有任何理由可以豁免。

原则2：**禁止**在未经用户明确同意的情况下修改 Git 暂存区（暂存或取消暂存）。
  除非用户明确要求提交，否则不要运行 `git add`、`git reset`、`git restore --staged` 或任何修改 git 暂存区的命令。所有暂存决策交给用户。

原则3：**数据以最丰富的形式流动，使用决策交给末端。**
  消费者不应要求上游裁剪数据。数据应在产生时以最完整的结构传递，消费者各取所需。
  - **生产者不做消费者的决策。** handler 不应为不同消费者分别构造不同粒度的数据——它只需发出一次完整数据，由消费者自行提取。
  - **统一数据源，多端消费。** 同一份数据结构服务于所有系统，避免同一信息在多处重复构造。

原则3：**始终使用最优、最完整的方案。**
  不走捷径，不用绕行方案。深入思考，选择最优实现。
  - **修复根本原因，而非表面症状。** 调查问题本质并修复底层机制，不要添加 workaround 或硬编码回退值。
  - **优选健壮、可维护的方案。** 即使 quick hack 能解决问题，也要选择正确、完整、经得起时间检验的方案。
  - **命名反映职责。** 函数名应准确描述其实际行为（如累积 vs 处理、收集 vs 转换），避免名不副实。
  - **Lint 服务于可读性，而非反过来。** 如果某条 lint 规则无益于可读性，应禁用它，而非扭曲代码来满足它。
  - **保留有意义的注释。** 编辑代码时不要删除已有的有意义的注释。注释解释了"为什么"，代码只体现"怎么做"——两者缺一不可。
  - **保持代码风格统一。** 同一函数、同一模块中，相似的逻辑应使用一致的写法。如果选定了某种模式（如 `const b = block as ...`），就在所有同类场景中贯彻到底。
  - **同模块导入使用相对路径。** 同一目录内的文件互相导入时，使用 `./foo` 而非 `~/lib/xxx/foo`，保持模块内聚性和可移植性。

- **不忽视已有的错误。**
  不要认为已有的测试失败、类型错误、导入缺失是"与我们无关的"。所有遇到的错误都必须修复。已有的错误意味着代码质量债务，放任不管会掩盖新引入的问题，使回归测试失去意义。
  - **修复时验证根因。** 不要猜测错误原因，先读取实际代码和类型定义，确认根因后再修复。

- **不要自动启动服务器。**
  不要运行 `bun run dev`、`bun run start` 或任何会启动服务器的命令。如需验证服务器行为，请让用户来启动。可以运行 `bun run typecheck`、`bun run lint:all`、`bun test` 等非服务器命令。

- **禁止杀死运行中的项目进程。**
  不要使用 `kill`、`pkill`、`killall` 或类似命令终止本项目的运行实例。如需重启，请让用户手动操作。

## 代码风格

- 使用 `@echristian/eslint-config` + Prettier。运行 `eslint --fix` 自动格式化（不要直接使用 `prettier --write`）。
- 不使用分号。三元运算符放在行首。
- 严格 TypeScript（`strict: true`）。避免 `any`。
- ESNext 模块，不用 CommonJS。路径别名 `~/*` 映射到 `src/*`。
- 测试：使用 Bun 内置测试运行器。测试文件放在 `tests/` 目录，命名为 `*.test.ts`。
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

## 关键配置

账户类型影响 Copilot API base URL：
- `individual` -> `api.githubcopilot.com`
- `business` -> `api.business.githubcopilot.com`
- `enterprise` -> `api.enterprise.githubcopilot.com`

`lib/state.ts` 中的关键运行时选项：

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `autoTruncate` | boolean | `true` | 响应式自动截断：限制错误时用截断的 payload 重试，对已知限制的模型进行预检查 |
| `compressToolResults` | boolean | `true` | 截断消息前先压缩旧的 tool_result 内容 |
| `redirectAnthropic` | boolean | `false` | 强制 Anthropic 请求走 OpenAI 转换 |
| `rewriteAnthropicTools` | boolean | `true` | 将服务端工具（web_search）重写为自定义格式 |

## 架构设计

@DESIGN.md

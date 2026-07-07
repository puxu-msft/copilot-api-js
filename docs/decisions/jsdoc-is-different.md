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

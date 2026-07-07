# Fix: Thinking Blocks Immutability

## 背景

### 问题现象

Claude Code 通过 Copilot proxy 与 Anthropic API 交互时，收到 400 错误：

```
messages.1.content.21: `thinking` or `redacted_thinking` blocks in the latest
assistant message cannot be modified. These blocks must remain as they were in
the original response.
```

### 根因分析

Anthropic API 要求 assistant 消息中的 `thinking` / `redacted_thinking` blocks 在后续请求中**完全不变**（包括 `signature` 和 `thinking` 字段）。API 通过签名验证 blocks 的完整性。

当前系统有两层问题：

1. **直接修改问题：** 多个 sanitize 管道会修改含 thinking blocks 的 assistant 消息的 content 数组（删除空 text blocks、过滤 orphaned tool blocks），虽然不改 thinking block 本身，但**改变了数组结构**
2. **Copilot proxy 合并效应：** GHC proxy 在转发到 Anthropic 前会合并/转换消息结构，合并后 thinking blocks 的位置或上下文变化触发签名验证失败

### 触发场景

实际案例中，9 条消息（4 assistant + 5 user）被发送到 Copilot proxy，proxy 合并后 Anthropic 看到的 `messages[1].content[21]` 位置的 thinking block 未通过签名验证。

## 代码审计

### 影响 assistant 消息 content 数组的所有代码路径

| 模块 | 函数 | 操作 | 是否检查 thinking |
| --- | --- | --- | --- |
| `sanitize/system-reminders.ts` | `sanitizeMessageParamContent()` | 清除 text blocks 中的 `<system-reminder>` 标签；空 text 被删除 | `isImmutableThinkingAssistantMessage()` — 需配置 |
| `sanitize/content-blocks.ts` | `filterEmptyAnthropicTextBlocks()` | 删除空 text blocks | `hasThinkingSignatureBlocks()` — 无条件保护 |
| `sanitize/tool-blocks.ts` | `processToolBlocks()` | 过滤 orphaned tool_use/tool_result、修复 tool name casing | `isImmutableThinkingAssistantMessage()` — 需配置 |
| `sanitize/deduplicate-tool-calls.ts` | `deduplicateToolCalls()` | 去重 tool_use/tool_result 对 | `hasThinkingSignatureBlocks()` 保护 tool IDs；`isImmutableThinkingAssistantMessage()` 阻止 merge |
| `auto-truncate/truncation.ts` | `stripThinkingBlocks()` | 删除旧消息的 thinking blocks | `isImmutableThinkingAssistantMessage()` — 需配置 |
| `auto-truncate/tool-utils.ts` | `filterAnthropicOrphanedToolResults()` | 过滤 orphaned tool_result blocks | **无检查** |
| `auto-truncate/tool-utils.ts` | `filterAnthropicOrphanedToolUse()` | 过滤 orphaned tool_use blocks | `isImmutableThinkingAssistantMessage()` — 需配置 |
| `auto-truncate/tool-utils.ts` | `ensureAnthropicStartsWithUser()` | 丢弃开头的 assistant 消息 | 无检查（丢弃整条消息） |

### 保护机制的双重标准

当前代码使用两个不同的检查函数：

- **`hasThinkingSignatureBlocks(msg)`** — 只检查消息是否含 thinking blocks，**不依赖配置**
- **`isImmutableThinkingAssistantMessage(msg)`** — 要求 `state.immutableThinkingMessages === true` **且**消息含 thinking blocks

`immutableThinkingMessages` 默认 `false`，因此所有使用 `isImmutableThinkingAssistantMessage()` 的保护在默认配置下**完全失效**。

只有 `content-blocks.ts` 和 `dedup-tool-calls.ts`（部分）使用了无条件的 `hasThinkingSignatureBlocks()`。

## 设计

### 核心原则

**Thinking blocks 的签名完整性是 Anthropic API 的硬性协议要求，不是可选行为。保护应默认开启，无需配置。**

### 方案

将 `isImmutableThinkingAssistantMessage()` 的行为改为**默认保护**：当 assistant 消息含有 thinking/redacted_thinking blocks 时，一律视为不可修改。`immutableThinkingMessages` 配置项反转含义：默认 `true`（保护），可设为 `false` 关闭保护（用于特殊调试场景）。

同时补齐所有缺失保护的代码路径。

### 变更清单

#### 1. `thinking-immutability.ts` — 反转默认值

```typescript
// 现在：
export function isImmutableThinkingAssistantMessage(msg: MessageParam): boolean {
  return state.immutableThinkingMessages && hasThinkingSignatureBlocks(msg)
}

// 改为：
export function isImmutableThinkingAssistantMessage(msg: MessageParam): boolean {
  // state.mutableThinkingMessages === true 时关闭保护（调试用）
  if (state.mutableThinkingMessages) return false
  return hasThinkingSignatureBlocks(msg)
}
```

#### 2. `state.ts` — 重命名配置项

```diff
- readonly immutableThinkingMessages: boolean
+ readonly mutableThinkingMessages: boolean
```

默认值改为 `false`（即默认不允许 mutable，等同于默认保护）。

配置项也对应改名：

```yaml
anthropic:
  # 旧：immutable_thinking_messages: true
  # 新：mutable_thinking_messages: false  # 设为 true 可关闭保护（调试用）
```

#### 3. `auto-truncate/tool-utils.ts` — 补齐缺失保护

`filterAnthropicOrphanedToolResults()` 缺少 thinking 保护。需添加：

```diff
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg)
      continue
    }

+   // Never modify assistant messages with thinking blocks
+   if (msg.role === "assistant" && hasThinkingSignatureBlocks(msg)) {
+     result.push(msg)
+     continue
+   }

    const filtered = msg.content.filter((block) => {
```

注意：此处使用 `hasThinkingSignatureBlocks()` 而非 `isImmutableThinkingAssistantMessage()`，因为这是协议级别的硬性要求，不应受配置开关控制。

实际上，由于方案 1 将 `isImmutableThinkingAssistantMessage()` 改为默认保护，两者行为一致。但为了清晰表达意图（"这不是可选的"），此处仍建议使用 `hasThinkingSignatureBlocks()`。

#### 4. `sanitize/system-reminders.ts` — 精细化处理

当前逻辑在 immutable 模式下跳过整条 assistant 消息。改进为：**即使不是 immutable 模式，也只修改 text blocks 的内容，不删除任何 block**（以保持 content 数组长度不变）。

```diff
  // 对 assistant 消息：sanitize text blocks，但不删除空 blocks
  if (msg.role === "assistant" && hasThinkingSignatureBlocks(msg)) {
-   return msg
+   // 只修改 text blocks 的文本内容，不增删 blocks
+   let modified = false
+   const blocks = msg.content.map((block) => {
+     if (block.type === "text" && "text" in block) {
+       const sanitized = removeSystemReminderTags(block.text)
+       if (sanitized !== block.text) {
+         modified = true
+         return { ...block, text: sanitized || " " }  // 保留空 block（用空格占位）
+       }
+     }
+     return block
+   })
+   return modified ? { role: "assistant", content: blocks } as AssistantMessage : msg
  }
```

#### 5. `auto-truncate/truncation.ts` — `stripThinkingBlocks()` 改进

当前在非 immutable 模式下会删除旧消息的 thinking blocks。**这是唯一合理的"修改 thinking 消息"场景**——因为旧消息的 thinking blocks 不是"latest assistant message"，API 只验证最后一条 assistant 消息的 thinking blocks。

但如果 Copilot proxy 会合并消息，导致"旧"thinking blocks 出现在合并后的"最后一条"assistant 消息中，则删除旧 thinking blocks 反而**安全**（因为不发送比发送一个被修改的更安全）。

**策略：** 对旧消息，`stripThinkingBlocks()` 行为不变（仍然删除旧 thinking blocks 以节省 tokens）。对最后一条 assistant 消息（`i >= stripBefore`），**绝不修改**。这是当前行为，无需改动。

#### 6. 配置迁移

保持向后兼容：

- 读取 `immutable_thinking_messages: true` → 等同于 `mutable_thinking_messages: false`（默认行为）
- 读取 `immutable_thinking_messages: false` → 等同于 `mutable_thinking_messages: true`（关闭保护）

在 `config.ts` 中添加迁移逻辑。

### 不变性保证矩阵

改动后各模块的保护状态：

| 模块 | 保护方式 | 默认行为 |
| --- | --- | --- |
| `system-reminders.ts` | `hasThinkingSignatureBlocks()` | 保留所有 blocks，只改 text 内容 |
| `content-blocks.ts` | `hasThinkingSignatureBlocks()` | 跳过整条消息（已有，不变） |
| `tool-blocks.ts` | `isImmutableThinkingAssistantMessage()` | 跳过整条消息（默认生效） |
| `deduplicate-tool-calls.ts` | `hasThinkingSignatureBlocks()` + `isImmutableThinkingAssistantMessage()` | 保护 tool IDs + 阻止 merge（已有，不变） |
| `stripThinkingBlocks()` | `isImmutableThinkingAssistantMessage()` | 保留最近消息的 thinking（默认生效） |
| `filterOrphanedToolResults()` | `hasThinkingSignatureBlocks()` | 跳过整条消息（**新增**） |
| `filterOrphanedToolUse()` | `isImmutableThinkingAssistantMessage()` | 跳过整条消息（默认生效） |

### 安全阀

如果新的默认保护导致意外的 API 错误（例如保留了不该保留的 blocks），用户可以通过 config.yaml 关闭：

```yaml
anthropic:
  mutable_thinking_messages: true
```

### 日志增强

在 sanitize 管道中增加日志，当跳过含 thinking blocks 的消息时记录：

```
[Sanitizer:Anthropic] Preserved 3 assistant messages with thinking blocks (immutable)
```

## 测试计划

### 单元测试

1. **`thinking-immutability.test.ts`** — 验证默认保护行为
   - `isImmutableThinkingAssistantMessage()` 默认返回 `true`（对含 thinking 的消息）
   - `mutableThinkingMessages: true` 时返回 `false`
   - 不含 thinking blocks 的消息始终返回 `false`

2. **`system-reminders.test.ts`** — 验证精细化处理
   - 含 thinking blocks 的 assistant 消息：text 内容被清理，blocks 数量不变
   - 清理后空 text 使用空格占位
   - 不含 thinking blocks 的 assistant 消息：行为不变

3. **`tool-utils.test.ts`** — 验证新增保护
   - `filterAnthropicOrphanedToolResults()` 跳过含 thinking blocks 的 assistant 消息
   - 不含 thinking blocks 的 assistant 消息：行为不变

4. **`tool-blocks.test.ts`** — 验证默认保护生效
   - `processToolBlocks()` 默认跳过含 thinking blocks 的 assistant 消息

5. **`config.test.ts`** — 配置迁移
   - `immutable_thinking_messages: true` → `mutableThinkingMessages: false`
   - `immutable_thinking_messages: false` → `mutableThinkingMessages: true`
   - `mutable_thinking_messages: true` → 关闭保护

### 集成测试

1. 构造一个完整的 9 条消息对话（含 4 个 assistant turns 各自带 thinking blocks），通过 sanitize + auto-truncate 管道后，验证：
   - 所有 thinking blocks 的 signature 和 thinking 字段不变
   - 所有含 thinking blocks 的 assistant 消息的 content 数组长度不变
   - text blocks 中的 `<system-reminder>` 标签被正确清理

2. 构造包含 orphaned tool blocks 的消息（部分在含 thinking 的 assistant 消息中），验证：
   - 不含 thinking 的 assistant 消息中 orphaned tools 被正确过滤
   - 含 thinking 的 assistant 消息中 orphaned tools 被保留（不修改）

## 文件变更清单

| 文件 | 变更类型 | 描述 |
| --- | --- | --- |
| `src/lib/anthropic/thinking-immutability.ts` | 修改 | 反转默认行为，使用 `mutableThinkingMessages` |
| `src/lib/state.ts` | 修改 | `immutableThinkingMessages` → `mutableThinkingMessages`，默认 `false` |
| `src/lib/config/config.ts` | 修改 | 配置项迁移 + 向后兼容 |
| `src/lib/anthropic/sanitize/system-reminders.ts` | 修改 | 精细化处理：保留 blocks 数量不变 |
| `src/lib/anthropic/auto-truncate/tool-utils.ts` | 修改 | `filterAnthropicOrphanedToolResults()` 添加保护 |
| `src/routes/config/route.ts` | 修改 | 配置 API 适配 |
| `config.example.yaml` | 修改 | 文档更新 |
| `tests/unit/anthropic-*` | 修改/新增 | 测试更新 |

## 风险评估

### 低风险

- 配置项重命名通过迁移逻辑保持向后兼容
- 默认保护是更安全的方向（从"默认不保护"到"默认保护"）
- 保护逻辑已在 `content-blocks.ts` 和 `dedup-tool-calls.ts` 验证过可行

### 中风险

- `system-reminders.ts` 的精细化处理（用空格占位而不是删除空 block）可能在极端情况下影响模型行为（空 text block vs 空格 text block），但比触发 400 错误好
- 含 thinking blocks 的 assistant 消息中的 orphaned tool blocks 不被清理，可能导致 payload 略大

### 缓解措施

- 安全阀配置可随时关闭保护
- 日志增强便于问题定位
- 旧消息的 thinking blocks 仍然会被 `stripThinkingBlocks()` 清理（节省 tokens）

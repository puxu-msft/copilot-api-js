# CRITICAL: Context Preservation for Remaining Edits

## Fix 3c: V1 OpenAI tool_calls — EXACT EDITS NEEDED

### Edit 1: Add msg parameter to renderMessageContent (line 1054)
OLD: `function renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap) {`
NEW: `function renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap, msg) {`

### Edit 2: At end of renderMessageContent, before `return html`, add OpenAI tool_calls rendering (around line 1116)
After the closing `}` of the `if (!hasVisibleBlocks && aggregateTools)` block at line ~1115, add:
```javascript
  // OpenAI format: render tool_calls from the message object
  if (msg && msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (filterType && filterType !== "tool_use") continue
      // Convert OpenAI tool_call to Anthropic-like tool_use block for rendering
      var toolUseBlock = {
        type: "tool_use",
        id: tc.id,
        name: tc.function ? tc.function.name : "unknown",
        input: tc.function ? tc.function.arguments : "{}",
      }
      // Try to parse arguments as JSON for prettier display
      try { toolUseBlock.input = JSON.parse(toolUseBlock.input) } catch (e) { /* keep as string */ }
      html += renderToolUseBlock(toolUseBlock, aggregateTools, toolResultMap)
    }
  }
  // OpenAI format: tool response message (role=tool with tool_call_id)
  if (msg && msg.role === "tool" && msg.tool_call_id && typeof content === "string") {
    if (!filterType || filterType === "tool_result") {
      var toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: content,
      }
      html += renderToolResultBlock(toolResultBlock, toolUseNameMap)
    }
  }
```

### Edit 3: Update 3 call sites in renderMessage (lines 1260, 1264, 1274)
Line 1260: `html += renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap)`
→ `html += renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap, msg)`

Line 1264: `html += renderMessageContent(rewrittenMsg.content, filterType, aggregateTools, toolResultMap, toolUseNameMap)`
→ `html += renderMessageContent(rewrittenMsg.content, filterType, aggregateTools, toolResultMap, toolUseNameMap, rewrittenMsg)`

Line 1274: `html += renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap)`
→ `html += renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap, msg)`

### Edit 4: Fix response rendering (line 764)
Currently: `html += renderMessage({ role: "assistant", content: msgContent }, filterType, false, null, toolUseNameMap)`
The issue: `const msgContent = responseContent.content ?? responseContent` strips tool_calls from OpenAI messages.
Fix: Instead of constructing a new object, use the full responseContent if it has tool_calls.

OLD (line 763-764):
```
const msgContent = responseContent.content ?? responseContent
html += renderMessage({ role: "assistant", content: msgContent }, filterType, false, null, toolUseNameMap)
```
NEW:
```
// Use full message object if it has role (preserves tool_calls for OpenAI format)
const responseMsg = responseContent.role
  ? responseContent
  : { role: "assistant", content: responseContent.content ?? responseContent }
html += renderMessage(responseMsg, filterType, false, null, toolUseNameMap)
```

## Fix 4: V3 SanitizationInfo type + MetaInfo — EXACT EDITS NEEDED

### Edit 5: V3 types/index.ts (lines 86-89)
OLD:
```typescript
export interface SanitizationInfo {
  removedBlockCount: number
  systemReminderRemovals: number
}
```
NEW:
```typescript
export interface SanitizationInfo {
  totalBlocksRemoved: number
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  systemReminderRemovals: number
}
```

### Edit 6: V3 MetaInfo.vue (lines 99-109)
OLD:
```html
    <div v-if="entry.rewrites?.sanitization" class="meta-section">
      <div class="meta-section-title">Sanitization</div>
      <div v-if="entry.rewrites.sanitization.removedBlockCount" class="meta-row">
        <span class="meta-label">Orphaned</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.removedBlockCount }} blocks removed</span>
      </div>
      <div v-if="entry.rewrites.sanitization.systemReminderRemovals" class="meta-row">
        <span class="meta-label">Reminders</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.systemReminderRemovals }} tags filtered</span>
      </div>
    </div>
```
NEW:
```html
    <div v-if="entry.rewrites?.sanitization" class="meta-section">
      <div class="meta-section-title">Sanitization</div>
      <div v-if="entry.rewrites.sanitization.totalBlocksRemoved" class="meta-row">
        <span class="meta-label">Blocks Removed</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.totalBlocksRemoved }} total</span>
      </div>
      <div v-if="entry.rewrites.sanitization.orphanedToolUseCount" class="meta-row">
        <span class="meta-label">Orphan tool_use</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.orphanedToolUseCount }}</span>
      </div>
      <div v-if="entry.rewrites.sanitization.orphanedToolResultCount" class="meta-row">
        <span class="meta-label">Orphan tool_result</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.orphanedToolResultCount }}</span>
      </div>
      <div v-if="entry.rewrites.sanitization.emptyTextBlocksRemoved" class="meta-row">
        <span class="meta-label">Empty text</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.emptyTextBlocksRemoved }}</span>
      </div>
      <div v-if="entry.rewrites.sanitization.systemReminderRemovals" class="meta-row">
        <span class="meta-label">Reminders</span>
        <span class="meta-value">{{ entry.rewrites.sanitization.systemReminderRemovals }} tags filtered</span>
      </div>
    </div>
```

## Verification Commands:
- `bun test` — all tests
- `bun run typecheck` — TypeScript check
- `cd src/ui/history-v3 && bun run build` — V3 Vite build

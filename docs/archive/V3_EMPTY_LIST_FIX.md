# Critical Bug Fix Plan — V3 Empty List

## Root Cause: Frontend/Backend Type Mismatches

### 1. HistoryEntry.request field optionality mismatch
**Backend** (`src/lib/history/store.ts:88-96`):
```typescript
request: {
  model?: string                  // OPTIONAL
  messages?: Array<MessageContent> // OPTIONAL
  stream?: boolean                // OPTIONAL
  tools?: Array<ToolDefinition>
  max_tokens?: number
  temperature?: number
  system?: string | Array<...>
}
```

**Frontend** (`src/ui/history-v3/src/types/index.ts:118-126`):
```typescript
request: {
  model: string                   // REQUIRED ← WRONG
  messages: Array<MessageContent> // REQUIRED ← WRONG, causes crash
  stream: boolean                 // REQUIRED ← WRONG
  tools?: Array<ToolDefinition>
  max_tokens?: number
  temperature?: number
  system?: string | Array<SystemBlock>
}
```

### 2. getPreviewText crash (useHistoryStore.ts:335-349)
When `messages` is undefined, `messages.length` throws TypeError.
Called from RequestItem.vue:44 - crashes entire list rendering.

### 3. getMessageSummary crash (useHistoryStore.ts:372-381)
Same issue: `entry.request.messages.length` and `.filter()` on undefined.

### 4. Stale `truncation` field on HistoryEntry (types/index.ts:142)
Frontend has `truncation?: TruncationInfo` directly on HistoryEntry.
Backend only has it inside `rewrites?.truncation`.
Frontend should NOT have `entry.truncation` - it should access `entry.rewrites?.truncation`.

### 5. Stale `toolCalls` field on response (types/index.ts:135-139)
Frontend defines `response.toolCalls?: Array<{id, name, input}>`.
Backend never sends this field. Should be removed.

## Files to Edit

1. **Test file**: `tests/unit/history-v3-types.test.ts` (NEW)
   - Test getPreviewText with undefined messages
   - Test getPreviewText with empty messages
   - Test getPreviewText with OpenAI string content
   - Test getMessageSummary with undefined messages
   - Test extractText with various formats

2. **`src/ui/history-v3/src/types/index.ts`**:
   - Line 119: `model: string` → `model?: string`
   - Line 120: `messages: Array<MessageContent>` → `messages?: Array<MessageContent>`
   - Line 121: `stream: boolean` → `stream?: boolean`
   - Line 142: DELETE `truncation?: TruncationInfo` (stale)
   - Lines 135-139: DELETE `toolCalls?: Array<...>` (stale)

3. **`src/ui/history-v3/src/composables/useHistoryStore.ts`**:
   - Line 336-337: Add null check: `if (!messages || messages.length === 0) return ""`
   - Line 348: `const last = messages.at(-1)` → add null check for `last`
   - Line 373: Add null check: `const msgCount = entry.request.messages?.length ?? 0`
   - Line 374: `entry.request.messages.filter(...)` → `(entry.request.messages ?? []).filter(...)`

4. **`src/ui/history-v3/src/components/list/RequestItem.vue`**:
   - Line 29: `entry.request.model` — needs `?? 'unknown'` fallback since now optional
   - Line 35: `entry.request.stream` — needs `?.` since now optional

5. **Components using `entry.truncation`**: Check and fix to use `entry.rewrites?.truncation`
   - `src/ui/history-v3/src/composables/useRewriteInfo.ts`
   - `src/ui/history-v3/src/components/detail/DetailPanel.vue`
   - `src/ui/history-v3/src/components/detail/MetaInfo.vue`

## Test Commands
- `bun test` — all tests
- `bun run typecheck` — backend TypeScript
- `cd src/ui/history-v3 && npx vite build` — V3 build

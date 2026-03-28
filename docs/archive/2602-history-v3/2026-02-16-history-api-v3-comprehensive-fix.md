# History API & V3 UI Comprehensive Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify backend data model (delete old API, merge RewriteMapping→RewriteInfo, fix data loss), then fix the ACTUALLY remaining V3 UI gaps + add OpenAI format rendering.

**Architecture:** Backend-first (4 tasks), then V3 UI fixes (4 tasks). The V3 UI is already much more complete than the comparison document suggests — most of the 46 listed issues have already been fixed. This revised plan targets only the genuinely remaining gaps.

**Tech Stack:** TypeScript, Bun test runner, Vue 3 + Composition API + TypeScript

**Commands:**
- Backend tests: `bun test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint:all`
- V3 build: `cd src/ui/history-v3 && bun run build` (or `npx vite build`)
- DO NOT run `bun run dev` or `bun run start`

---

## ⚠️ CRITICAL: Comparison Document is Outdated

The file `src/ui/history-v3/V1_VS_V3_COMPARISON.md` lists 27 ❌ and 19 ⚠️ items.
**Most are already fixed in V3.** After reading every V3 source file, the ACTUALLY remaining issues are:

### Already Fixed (DO NOT re-implement):
- A4 (scroll to bottom on select) — `DetailPanel.vue` line 113-121 watches selection + scrolls
- A5 (auto-select) — `useHistoryStore.ts` line 121-124 auto-selects first entry
- B2 (session time) — `AppHeader.vue` line 18 uses `formatDate(s.startTime)`
- B3 (refresh feedback) — `AppHeader.vue` line 58-65 has `refreshing` ref
- B6 (export) — `AppHeader.vue` line 27 uses `location.href`
- B10 (Esc export) — `AppHeader.vue` line 37-41 has Esc handler
- D2 (search count) — `RequestList.vue` line 49-51 shows hit count
- D11 (duration) — `RequestItem.vue` line 40-42 shows duration
- D14 (pagination) — `ListPagination.vue` has full page number buttons
- D15 (empty subtitle) — `RequestList.vue` line 74 has subtitle
- E3 (search scroll) — `DetailPanel.vue` line 102-110 scrolls to match
- E4 (tool role) — `DetailToolbar.vue` line 20 has tool option
- E9 (section Raw) — `SectionBlock.vue` line 39-47 has Raw button + modal
- F6 (system collapse) — `SystemMessage.vue` line 20,67-73 has collapse
- F7 (system expand) — `SystemMessage.vue` line 84-91 has expand buttons
- G4 (collapsed summary) — `MessageBlock.vue` line 100-110 computes summary
- G8 (200px threshold) — `MessageBlock.vue` line 310 uses 200px
- H1-H4 (TextBlock) — `TextBlock.vue` line 25 uses ContentBlockWrapper with `label="TEXT"`
- I4-I6 (ToolUse) — `ToolUseBlock.vue` uses ContentBlockWrapper
- J3 (tool_use_id) — `ToolResultBlock.vue` line 44,64 shows ID
- J4 (Jump to call) — `ToolResultBlock.vue` line 46-48,71-74 has jump link
- J6-J8 (ToolResult) — `ToolResultBlock.vue` uses ContentBlockWrapper
- K2-K4 (Thinking) — `ThinkingBlock.vue` uses ContentBlockWrapper
- L2 (IMAGE label) — `ImageBlock.vue` line 12-14 has label + media_type
- L3 (Image Raw) — `ImageBlock.vue` line 15 has raw-data
- R3 (Copy button) — `RawJsonModal.vue` line 43-46 has Copy button
- X1 (Time) — `MetaInfo.vue` line 16-18 shows Time
- X15/X16 (sanitization) — `MetaInfo.vue` line 98-109 shows sanitization info
- X18 (Error block) — `MetaInfo.vue` line 74-77 shows error
- P3 (strikethrough) — `MessageBlock.vue` line 211-215 has line-through for truncated

### Actually Remaining Issues:
1. **OpenAI format rendering** — ContentRenderer doesn't handle `tool_calls`, toolMaps doesn't scan them
2. **Highlight flash CSS** — `highlightBlock()` in DetailPanel calls `classList.add("highlight-flash")` but NO `@keyframes highlight-flash` exists in any CSS
3. **RawJsonModal deep** — Uses `:deep="Infinity"` which renders huge trees; should be limited. No string truncation for long values.
4. **useKeyboard Esc** — Checks for `.modal-overlay` but NOT for export dropdown open state
5. **Responsive SplitPane** — `AppHeader.vue` has mobile breakpoint but `SplitPane.vue` doesn't stack vertically on mobile

---

## Phase 1: Backend Data Model Cleanup

### Task 1: Delete Old History API

**WHY:** `recordRequest()`, `recordResponse()`, `recordRewrites()` are legacy functions in `store.ts` that are no longer called anywhere in the codebase. The new `insertEntry()`/`updateEntry()` API is used instead. Dead code should be removed.

**Files to modify:**

#### File: `src/lib/history/store.ts`

This file exports the history store. It contains both the old API (to delete) and the new API (to keep).

**Current structure** (simplified):
```
Lines 1-67:    imports, HistoryEntry type, constants
Lines 68-80:   RewriteInfo interface (KEEP — this becomes the unified type)
Lines 81-112:  TruncationInfo, SanitizationInfo interfaces (KEEP)
Lines 113-160: MessageContent interface, HistoryStore class, store state (KEEP)
Lines 161-236: insertEntry(), updateEntry(), deleteEntry(), getEntry(), getEntries(), clearEntries(), toJSON() (KEEP)
Lines 237-246: RecordRequestParams interface (DELETE)
Lines 247-316: recordRequest() function (DELETE)
Lines 317-329: RecordResponseParams interface (DELETE)
Lines 330-352: recordResponse() function (DELETE)
Lines 353-364: recordRewrites() function (DELETE)
Lines 365+:    remaining exports (KEEP, remove deleted items from exports)
```

**Action:** Delete lines 237-364 (the `RecordRequestParams` interface through the end of `recordRewrites()` function). Then update the export block at the bottom of the file to remove `recordRequest`, `recordResponse`, `recordRewrites`, `RecordRequestParams`, `RecordResponseParams`.

**IMPORTANT:** Read the actual file first to get exact line ranges. The line numbers above are approximate from the last read.

#### File: `src/lib/history/index.ts`

This is the barrel re-export file. Remove the deleted items from exports.

**Current exports include:**
```typescript
// Values
export {
  recordRequest,     // DELETE
  recordResponse,    // DELETE
  recordRewrites,    // DELETE
  insertEntry,
  updateEntry,
  // ... others
} from "./store"

// Types
export type {
  RecordRequestParams,   // DELETE
  RecordResponseParams,  // DELETE
  RewriteInfo,
  // ... others
} from "./store"
```

**Action:** Remove the 5 items marked DELETE from their respective export blocks.

#### File: `tests/component/history-store.test.ts`

**Action:** Read this file. If it contains tests using `recordRequest()`/`recordResponse()`/`recordRewrites()`, rewrite those tests to use `insertEntry()`/`updateEntry()` instead.

The tests should construct `HistoryEntry`-compatible objects directly and pass them to `insertEntry()`. For response recording, use `updateEntry(id, { response: {...} })`.

**Verification:**
```bash
bun test tests/component/history-store.test.ts
bun run typecheck
```

**Commit:**
```bash
git commit -m "refactor: remove unused recordRequest/recordResponse/recordRewrites API

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Unify RewriteMapping → RewriteInfo

**WHY:** Two nearly identical interfaces exist for the same data:
- `RewriteMapping` in `src/lib/context/request.ts` (used by RequestContext)
- `RewriteInfo` in `src/lib/history/store.ts` (used by HistoryStore)

The consumer in `consumers.ts` does 20+ lines of field-by-field copying to convert between them. After unification, this becomes a direct pass-through.

**Files to modify:**

#### File: `src/lib/context/request.ts`

**Current `RewriteMapping` (to DELETE — find by searching for `interface RewriteMapping`):**
```typescript
export interface RewriteMapping {
  rewrittenMessages: Array<unknown>
  rewrittenSystem?: string
  messageMapping?: Array<number>
  sanitization?: {
    totalBlocksRemoved: number
    orphanedToolUseCount?: number
    orphanedToolResultCount?: number
    fixedNameCount?: number
    emptyTextBlocksRemoved?: number
    systemReminderRemovals: number
  }
  truncation?: {
    removedMessageCount: number
    originalTokens?: number
    compactedTokens?: number
    processingTimeMs?: number
  }
}
```

**Action:**
1. Add import at top of file: `import type { RewriteInfo } from "~/lib/history/store"`
2. Delete the entire `RewriteMapping` interface
3. Find-and-replace all occurrences of `RewriteMapping` with `RewriteInfo` in this file:
   - In the `RequestContext` interface: `readonly rewrites: RewriteMapping | null` → `readonly rewrites: RewriteInfo | null`
   - In the `setRewrites` signature: `setRewrites(info: RewriteMapping): void` → `setRewrites(info: RewriteInfo): void`
   - In the implementation: `let _rewrites: RewriteMapping | null = null` → `let _rewrites: RewriteInfo | null = null`
   - The `setRewrites` function body: parameter type `RewriteMapping` → `RewriteInfo`

#### File: `src/lib/context/index.ts`

**Action:** Remove `RewriteMapping` from the type exports. The type `RewriteInfo` is already exported from `~/lib/history` — consumers should import from there.

#### File: `src/lib/anthropic/handlers.ts`

**Current `setRewrites` call** (search for `ctx.setRewrites`):
```typescript
ctx.setRewrites({
  rewrittenMessages: messages as Array<unknown>,
  rewrittenSystem: system,
  messageMapping: mapping,
  sanitization: sanitizationInfo,
  truncation: truncationInfo,
})
```

**Action:** Since `RewriteInfo.rewrittenMessages` is typed as `MessageContent[]` (not `unknown[]`), change the cast:
```typescript
ctx.setRewrites({
  rewrittenMessages: messages as MessageContent[],
  rewrittenSystem: system,
  messageMapping: mapping,
  sanitization: sanitizationInfo,
  truncation: truncationInfo,
})
```

Also ensure `MessageContent` is imported from `~/lib/history/store`.

**Note:** The `sanitizationInfo` and `truncationInfo` variables should already be typed as `SanitizationInfo` and `TruncationInfo` — verify by reading the code. If they are inline objects, they need to match the `SanitizationInfo`/`TruncationInfo` interfaces from `store.ts`. Key difference: `RewriteMapping` had optional fields like `orphanedToolUseCount?: number` while `SanitizationInfo` may have them as required. Check the actual `SanitizationInfo` interface and add `?? 0` defaults at the call site if needed.

#### File: `src/lib/translation/handlers.ts`

Same as above — find the `setRewrites` call and update the `rewrittenMessages` cast. Ensure the sanitization/truncation objects match `SanitizationInfo`/`TruncationInfo`.

#### File: `tests/component/request-context.test.ts`

**Action:** Update `setRewrites()` test calls to pass data matching `RewriteInfo` shape. The main difference is `rewrittenMessages` should be typed as `MessageContent[]` instead of `unknown[]`.

**Verification:**
```bash
bun test && bun run typecheck
```

**Commit:**
```bash
git commit -m "refactor: unify RewriteMapping → RewriteInfo, single type for rewrite data

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Simplify Consumer Translation Layer

**WHY:** After Task 2, `RequestContext.rewrites` is already `RewriteInfo | null`. The consumer no longer needs to convert between types.

**File: `src/lib/context/consumers.ts`**

**Current code** (the `case "updated"` block — ~30 lines of field mapping):
```typescript
case "updated": {
  if (event.field === "rewrites") {
    const ctx = event.context
    if (ctx.rewrites) {
      const rewrites: RewriteInfo = {
        rewrittenMessages: ctx.rewrites.rewrittenMessages as MessageContent[],
        rewrittenSystem: ctx.rewrites.rewrittenSystem,
        messageMapping: ctx.rewrites.messageMapping,
      }

      if (ctx.rewrites.sanitization) {
        rewrites.sanitization = {
          totalBlocksRemoved: ctx.rewrites.sanitization.totalBlocksRemoved,
          orphanedToolUseCount: ctx.rewrites.sanitization.orphanedToolUseCount ?? 0,
          orphanedToolResultCount: ctx.rewrites.sanitization.orphanedToolResultCount ?? 0,
          fixedNameCount: ctx.rewrites.sanitization.fixedNameCount ?? 0,
          emptyTextBlocksRemoved: ctx.rewrites.sanitization.emptyTextBlocksRemoved ?? 0,
          systemReminderRemovals: ctx.rewrites.sanitization.systemReminderRemovals,
        }
      }

      if (ctx.rewrites.truncation) {
        rewrites.truncation = {
          removedMessageCount: ctx.rewrites.truncation.removedMessageCount,
          originalTokens: ctx.rewrites.truncation.originalTokens,
          compactedTokens: ctx.rewrites.truncation.compactedTokens,
          processingTimeMs: ctx.rewrites.truncation.processingTimeMs,
        }
      }

      updateEntry(ctx.id, { rewrites })
    }
  }
  break
}
```

**Replace with:**
```typescript
case "updated": {
  if (event.field === "rewrites" && event.context.rewrites) {
    updateEntry(event.context.id, { rewrites: event.context.rewrites })
  }
  break
}
```

**Also:** Remove now-unused imports (`MessageContent`, `RewriteInfo` if no longer needed by other cases, etc.). Read the file first to check what other imports are still used.

**Verification:**
```bash
bun test && bun run typecheck
```

**Commit:**
```bash
git commit -m "refactor: simplify consumer rewrite pass-through after type unification

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Fix toHistoryEntry() Data Loss

**WHY:** The `toHistoryEntry()` method on `RequestContext` loses data:
1. `system` only serializes `string` format, drops `Array<SystemBlock>` format
2. `rewrites` only copies `rewrittenMessages` + `messageMapping`, drops `sanitization`/`truncation`

**File: `src/lib/context/request.ts`**

**Finding the code:** Search for `toHistoryEntry` function. It constructs and returns a `HistoryEntryData` object.

**Fix 1: System serialization**

Find:
```typescript
system: typeof _originalRequest?.system === "string" ? _originalRequest.system : undefined,
```

Replace with:
```typescript
system: _originalRequest?.system,
```

**Fix 2: Rewrites data loss**

Find the section where `_rewrites` is serialized. It currently does something like:
```typescript
if (_rewrites) {
  entry.rewrites = {
    rewrittenMessages: _rewrites.rewrittenMessages,
    messageMapping: _rewrites.messageMapping,
  }
}
```

Replace with:
```typescript
if (_rewrites) {
  entry.rewrites = _rewrites
}
```

This preserves all fields including `sanitization`, `truncation`, `rewrittenSystem`.

**Fix 3: HistoryEntryData.request.system type**

Find the `HistoryEntryData` interface (or the type of the `request` object in `toHistoryEntry`). The `system` field should accept both formats:

```typescript
system?: string | Array<{ type: string; text: string; cache_control?: { type: string } | null }>
```

If the type is already broad enough (e.g., `unknown` or `any`), skip this step. Read the actual type first.

**Verification:**
```bash
bun test && bun run typecheck
```

**Commit:**
```bash
git commit -m "fix: preserve system array format and rewrite metadata in toHistoryEntry()

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 2: V3 UI — Remaining Fixes

### Task 5: OpenAI Format — Type Guards & Normalizer

**WHY:** The V3 UI only renders Anthropic `ContentBlock[]` format. When a request comes through the OpenAI endpoint:
- `msg.content` is a plain string
- `msg.tool_calls` is an array of `{ id, type, function: { name, arguments } }` objects
- Tool responses have `role: "tool"` and `tool_call_id: string`

None of these are rendered because ContentRenderer only iterates `msg.content` as an array.

**File: `src/ui/history-v3/src/utils/typeGuards.ts`**

**Current content** (read first to see existing guards). The file exports type guard functions like `isTextBlock()`, `isToolUseBlock()`, etc.

**Add at the end of the file:**

```typescript
// ============================================================================
// OpenAI format helpers
// ============================================================================

/** Check if a message uses OpenAI tool_calls format (assistant with function calls) */
export function hasOpenAIToolCalls(msg: MessageContent): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
}

/** Check if a message is an OpenAI tool response (role: "tool" with tool_call_id) */
export function isOpenAIToolResponse(msg: MessageContent): boolean {
  return msg.role === "tool" && typeof msg.tool_call_id === "string"
}

/**
 * Normalize a message's content to a ContentBlock array for rendering.
 *
 * Handles three cases:
 * 1. Anthropic format: content is already ContentBlock[] → return as-is
 * 2. OpenAI text + tool_calls: convert string content to text block + tool_calls to tool_use blocks
 * 3. OpenAI tool response: convert to tool_result block
 */
export function normalizeToContentBlocks(msg: MessageContent): ContentBlock[] {
  const blocks: ContentBlock[] = []

  // 1. Handle content field
  if (typeof msg.content === "string") {
    if (msg.content) {
      blocks.push({ type: "text", text: msg.content } as TextContentBlock)
    }
  } else if (Array.isArray(msg.content)) {
    // Already Anthropic format
    blocks.push(...(msg.content as ContentBlock[]))
  }

  // 2. Handle OpenAI tool_calls → virtual tool_use blocks
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>
      } catch {
        input = { _raw: tc.function.arguments }
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      } as ToolUseContentBlock)
    }
  }

  // 3. Handle OpenAI tool response → virtual tool_result block
  if (msg.role === "tool" && msg.tool_call_id) {
    const resultContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    // Replace any text block we added above — this IS the tool result
    blocks.length = 0
    blocks.push({
      type: "tool_result",
      tool_use_id: msg.tool_call_id,
      content: resultContent,
    } as ToolResultContentBlock)
  }

  return blocks
}
```

**Note:** The types `TextContentBlock`, `ToolUseContentBlock`, `ToolResultContentBlock` should already be imported or defined in this file. Read the file's existing imports first. The types are defined in `src/ui/history-v3/src/types/index.ts`. Also import `MessageContent` from there if not already imported.

**Verification:**
```bash
cd src/ui/history-v3 && bun run build
```

**Commit:**
```bash
git commit -m "feat(v3): add OpenAI format type guards and normalizeToContentBlocks helper

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: OpenAI Format — Wire into Rendering Pipeline

**WHY:** The type guards from Task 5 need to be wired into ContentRenderer, DetailPanel, and MessageBlock.

**File: `src/ui/history-v3/src/components/message/ContentRenderer.vue`**

**Current logic** (simplified from last read):
```vue
<script setup lang="ts">
const props = defineProps<{
  content: string | Array<ContentBlock>
  searchQuery?: string
  // ...
}>()

// Content is rendered by iterating over `blocks`:
const blocks = computed(() => {
  if (typeof props.content === "string") {
    return [{ type: "text", text: props.content }]
  }
  return props.content ?? []
})
</script>

<template>
  <div class="content-renderer">
    <template v-for="(block, i) in blocks" :key="i">
      <TextBlock v-if="isTextBlock(block)" ... />
      <ToolUseBlock v-else-if="isToolUseBlock(block)" ... />
      <ToolResultBlock v-else-if="isToolResultBlock(block)" ... />
      <ThinkingBlock v-else-if="isThinkingBlock(block)" ... />
      <ImageBlock v-else-if="isImageBlock(block)" ... />
    </template>
  </div>
</template>
```

**Changes:**
1. Add an optional `message` prop:
```typescript
const props = defineProps<{
  content: string | Array<ContentBlock>
  message?: MessageContent  // Full message for OpenAI tool_calls access
  searchQuery?: string
  // ... (keep all existing props)
}>()
```

2. Update the `blocks` computed to use `normalizeToContentBlocks` when `message` is provided:
```typescript
import { normalizeToContentBlocks } from "@/utils/typeGuards"

const blocks = computed<ContentBlock[]>(() => {
  // If full message is provided, use the normalizer (handles both formats)
  if (props.message) {
    return normalizeToContentBlocks(props.message)
  }
  // Fallback: content-only mode (backward compatible)
  if (typeof props.content === "string") {
    return props.content ? [{ type: "text", text: props.content } as ContentBlock] : []
  }
  return props.content ?? []
})
```

**File: `src/ui/history-v3/src/components/message/MessageBlock.vue`**

**Changes:** Pass the full message to ContentRenderer. Find where `<ContentRenderer>` is used in the template. Add `:message="displayMessage"` prop.

The `displayMessage` should be the actual message object (original or rewritten depending on view mode). Read the file to find:
- The existing `displayContent` computed (this is `content` for ContentRenderer)
- How view mode switching works (original vs rewritten)

Add:
```typescript
const displayMessage = computed<MessageContent | undefined>(() => {
  // Only pass message for original view — rewritten view already has correct content blocks
  if (viewMode.value === 'original') {
    return props.message
  }
  return undefined
})
```

Then in template: `<ContentRenderer :content="displayContent" :message="displayMessage" ... />`

**File: `src/ui/history-v3/src/components/detail/DetailPanel.vue`**

**Changes:** The `toolUseNameMap` and `toolResultMap` computeds need to also scan `msg.tool_calls`:

Find the computed that builds tool maps (search for `toolUseNameMap` or `nameMap`). After the existing content block scan, add:

```typescript
// Also scan OpenAI-format tool_calls
if (msg.tool_calls) {
  for (const tc of msg.tool_calls) {
    nameMap[tc.id] = tc.function.name
  }
}
// Also handle OpenAI tool responses
if (msg.role === "tool" && msg.tool_call_id) {
  resultMap[msg.tool_call_id] = {
    type: "tool_result",
    tool_use_id: msg.tool_call_id,
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
  } as ToolResultContentBlock
}
```

**Verification:**
```bash
cd src/ui/history-v3 && bun run build
```

**Commit:**
```bash
git commit -m "feat(v3): render OpenAI tool_calls and tool responses in history UI

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Highlight Flash CSS + RawJsonModal Improvements

**WHY:**
1. `DetailPanel.vue` calls `el.classList.add("highlight-flash")` on tool jump but the CSS `@keyframes highlight-flash` doesn't exist in any stylesheet
2. `RawJsonModal.vue` uses `:deep="Infinity"` which can make huge JSON trees unresponsive. Should limit depth and truncate long strings.

**File: `src/ui/history-v3/src/styles/base.css`**

**Add at end of file:**
```css
/* ═══ Highlight Flash Animation ═══ */
@keyframes highlight-flash {
  0%, 100% { border-color: var(--border); }
  25%, 75% { border-color: var(--primary); }
}
.highlight-flash {
  animation: highlight-flash 0.4s ease-in-out 2;
}
```

**File: `src/ui/history-v3/src/components/ui/RawJsonModal.vue`**

Read first to find the `vue-json-pretty` usage. Current props likely include `:deep="Infinity"`.

**Changes:**
1. Change `:deep="Infinity"` to `:deep="5"` (or similar reasonable depth)
2. Add `:showLength="true"` to show array/object lengths
3. For string truncation: `vue-json-pretty` doesn't have built-in truncation. Add a `processData` function that truncates string values over 500 chars:

```typescript
function processJsonForDisplay(data: unknown): unknown {
  if (typeof data === "string" && data.length > 500) {
    return data.slice(0, 500) + `... (${data.length} chars total)`
  }
  if (Array.isArray(data)) {
    return data.map(processJsonForDisplay)
  }
  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = processJsonForDisplay(value)
    }
    return result
  }
  return data
}
```

Pass `processJsonForDisplay(props.data)` to vue-json-pretty instead of raw `props.data`.

**Verification:**
```bash
cd src/ui/history-v3 && bun run build
```

**Commit:**
```bash
git commit -m "fix(v3): add highlight-flash CSS animation, limit Raw JSON depth & truncate long strings

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Keyboard Esc Fix + Responsive SplitPane + Final Verification

**WHY:**
1. `useKeyboard.ts` calls `onEscape()` (which clears selection) even when the export dropdown is open — should let the dropdown handle its own Esc first
2. `SplitPane.vue` doesn't have a mobile breakpoint — should stack vertically on narrow screens

**File: `src/ui/history-v3/src/composables/useKeyboard.ts`**

Read the file first. Find the Escape case. Current code:
```typescript
case "Escape":
  if (!document.querySelector(".modal-overlay")) {
    options.onEscape()
  }
  break
```

**Replace with:**
```typescript
case "Escape": {
  // Don't clear selection if a modal or dropdown is open — let them handle Esc first
  if (document.querySelector(".modal-overlay")) break
  if (document.querySelector(".export-dropdown.is-open, .export-menu.is-open")) break
  options.onEscape()
  break
}
```

**Note:** Check the actual class names used by the export dropdown in `AppHeader.vue`. The above uses placeholder class names — read the code to find the real selector.

**File: `src/ui/history-v3/src/components/layout/SplitPane.vue`**

Read the file. Add a mobile media query to the `<style>` section:

```css
@media (max-width: 768px) {
  .split-pane {
    flex-direction: column;
  }
  .split-pane .divider {
    display: none;
  }
  .split-pane > :first-child {
    max-height: 40vh;
  }
}
```

**Final Verification:**
```bash
bun test
bun run typecheck
bun run lint:all
cd src/ui/history-v3 && bun run build
```

Fix any errors that appear. Then commit:
```bash
git commit -m "fix(v3): Esc priority for export dropdown, responsive split pane layout

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Appendix A: File Map

All files potentially modified by this plan:

### Backend (Phase 1)
| File | Tasks |
|------|-------|
| `src/lib/history/store.ts` | 1 |
| `src/lib/history/index.ts` | 1 |
| `src/lib/context/request.ts` | 2, 4 |
| `src/lib/context/index.ts` | 2 |
| `src/lib/context/consumers.ts` | 3 |
| `src/lib/anthropic/handlers.ts` | 2 |
| `src/lib/translation/handlers.ts` | 2 |
| `tests/component/history-store.test.ts` | 1 |
| `tests/component/request-context.test.ts` | 2 |

### V3 UI (Phase 2)
| File | Tasks |
|------|-------|
| `src/ui/history-v3/src/utils/typeGuards.ts` | 5 |
| `src/ui/history-v3/src/components/message/ContentRenderer.vue` | 6 |
| `src/ui/history-v3/src/components/message/MessageBlock.vue` | 6 |
| `src/ui/history-v3/src/components/detail/DetailPanel.vue` | 6 |
| `src/ui/history-v3/src/styles/base.css` | 7 |
| `src/ui/history-v3/src/components/ui/RawJsonModal.vue` | 7 |
| `src/ui/history-v3/src/composables/useKeyboard.ts` | 8 |
| `src/ui/history-v3/src/components/layout/SplitPane.vue` | 8 |

## Appendix B: Key Type References

### RewriteInfo (unified type — `src/lib/history/store.ts`)
```typescript
export interface RewriteInfo {
  truncation?: TruncationInfo
  sanitization?: SanitizationInfo
  rewrittenMessages?: MessageContent[]
  rewrittenSystem?: string
  messageMapping?: number[]
}
```

### TruncationInfo (`src/lib/history/store.ts`)
```typescript
export interface TruncationInfo {
  removedMessageCount: number
  originalTokens?: number
  compactedTokens?: number
  processingTimeMs?: number
}
```

### SanitizationInfo (`src/lib/history/store.ts`)
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

### MessageContent (`src/ui/history-v3/src/types/index.ts`)
```typescript
export interface MessageContent {
  role: string
  content: string | ContentBlock[] | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}
```

### ContentBlock types (`src/ui/history-v3/src/types/index.ts`)
```typescript
export interface TextContentBlock { type: "text"; text: string }
export interface ToolUseContentBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultContentBlock { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] }
export interface ThinkingContentBlock { type: "thinking"; thinking: string }
export interface ImageContentBlock { type: "image"; source: { type: string; media_type: string; data: string } }
export type ContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock | ThinkingContentBlock | ImageContentBlock
```

**⚠️ NOTE:** The type definitions above are approximate from the last read. Always read the actual files to verify exact shapes before implementing.

## Appendix C: What NOT To Do

1. **Do NOT re-implement items already in V3.** The comparison doc is outdated. See the "Already Fixed" section at the top.
2. **Do NOT run `bun run dev` or `bun run start`.** These start the server.
3. **Do NOT use `kill`, `pkill`, etc.** to stop processes.
4. **Do NOT run `git checkout --`, `git restore`, `git reset --hard`, `git clean -f`.** These are destructive.
5. **Do NOT modify git staging without explicit user permission.** Don't run `git add` unless committing.
6. **Do NOT use semicolons in TypeScript code.** Project uses no-semicolon style.
7. **Do NOT add unnecessary comments or docstrings** to code you didn't write.

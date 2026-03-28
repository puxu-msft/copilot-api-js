# History API & V3 UI Comprehensive Fix — Design Document

Date: 2026-02-16

## Overview

Comprehensively fix the history system across two dimensions:
1. **Backend**: Unify data model, remove dead code, fix data loss
2. **Frontend V3**: Supplement all 27 missing features and fix 19 defects vs V1

## Part 1: Backend Data Model Unification

### 1.1 Remove Old API

Delete from `store.ts`:
- `recordRequest()` + `RecordRequestParams`
- `recordResponse()` + `RecordResponseParams`
- `recordRewrites()`

Remove from `index.ts` barrel exports. Update tests that reference old API.

### 1.2 Unify Rewrite Types

**Delete** `RewriteMapping` from `request.ts`.
**Keep** `RewriteInfo` from `store.ts` as the unified type.

`RequestContext.setRewrites()` changes signature from `RewriteMapping` to `RewriteInfo`.
Pipeline code constructs `RewriteInfo` directly (moves `?? 0` defaults to producer side).
Consumer translation layer in `consumers.ts` becomes a direct pass-through.

### 1.3 Fix `toHistoryEntry()` Data Loss

Current issues:
- `system` only serialized as string, loses `Array<SystemBlock>` format
- `rewrites` doesn't include sanitization/truncation info
- `rewrites.rewrittenSystem` not forwarded

Fix: `toHistoryEntry()` preserves all data fields completely.

### 1.4 Consumer Simplification

After type unification, `handleHistoryEvent` "updated" branch changes from 20+ lines of field-by-field mapping to `updateEntry(ctx.id, { rewrites: ctx.rewrites })`.

## Part 2: Frontend V3 Feature Parity

### 2.1 Core Structural Change — Content Block Collapse Mechanism

Add two-layer collapse to ALL content blocks (TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock):
1. **Block-level collapse**: Click collapse-icon → fold to one-line summary
2. **Content expand**: Body max-height 200px + Expand/Collapse button

Collapsed summary shows first 80 chars or block type counts.

### 2.2 Fixes by Component

#### Page Layout (A)
- A3: Add `@media (max-width: 768px)` responsive breakpoint
- A4: After selecting entry, scroll detail panel to bottom
- A5: Auto-select first (newest) entry on initial load

#### Header (B)
- B2: Session selector shows `formatDate(startTime) + " (N reqs)"` instead of ID prefix
- B3: Refresh shows loading visual feedback (list opacity 0.5)
- B4: Refresh reloads currently selected entry detail
- B6: Export uses `location.href` (current window download) not `window.open`
- B10: Esc key closes Export menu

#### Request List (D)
- D2: Show search hit count ("N hits")
- D11: Show duration in list items
- D14: Pagination with page number buttons (max 5 + ellipsis)
- D15: Empty state with subtitle "Try adjusting your filters"

#### Detail Panel (E)
- E3: Search scrolls to first match (scrollIntoView)
- E4: Add "tool" role filter option
- E9: Section-level Raw buttons (REQUEST/RESPONSE/META each have own Raw)

#### System Message (F)
- F6: Collapsible to one-line summary (first 80 chars)
- F7: Expand button when content exceeds max-height

#### Message Block (G)
- G4: Show summary when collapsed (first 80 chars or "3 text, 2 tool_use")
- G8: Expand threshold 500px → 200px

#### Content Blocks — All Types
- H1-H4: TextBlock — add TEXT label, collapse header, body-collapsed, Expand button
- I4-I6: ToolUseBlock — add collapse header, body-collapsed, Expand button
- J3: ToolResultBlock — show tool_use_id
- J4: "← Jump to call" reverse link
- J6-J8: ToolResultBlock — collapse header, body-collapsed, Expand button
- K2-K4: ThinkingBlock — collapse header, body-collapsed, Expand button

#### Tool Interaction
- I10/J5: Jump target highlight flash animation (border color flash keyframe)
- V6: @keyframes highlight-flash CSS animation

#### Aggregation Mode
- O2: Show "Tool results aggregated to: ← {id}" link when message only contains aggregated tool_result

#### Truncation Visualization
- P1: Truncation divider placed after last truncated message (not before all messages)
- P3: Truncated messages get text strikethrough effect

#### Raw Modal
- R2: Long strings (>300 chars) truncated with "(N chars - click to expand)"
- R3: Copy button in modal header

#### META Section
- X1: Show request time
- X15: Show sanitization orphaned blocks info
- X16: Show sanitization system reminder filter info
- X18: Error block in response section (red error display)

#### Image Block
- L2: IMAGE type label + media_type display
- L3: Raw button

#### Keyboard Behavior
- T4: Esc first closes modal/menu, then clears selection (not directly clear selection)

### 2.3 OpenAI Format Support in V3 UI

V3 currently only renders Anthropic ContentBlock[] format. OpenAI format messages
(string content + tool_calls array + tool_call_id) are not rendered correctly.

Fix: UI adapts to both formats (preserving original data in the store):

#### ContentRenderer.vue
- When content is string AND message has `tool_calls`, convert tool_calls to
  virtual ContentBlock[] for rendering (tool_use blocks)
- When message has `tool_call_id` (tool role), render as tool_result equivalent

#### DetailPanel.vue
- Tool maps construction must also scan `message.tool_calls` for OpenAI format
- Aggregate Tools must work across both formats

#### MessageBlock.vue
- `displayContent` computed must include tool_calls from message level

#### Type Guards
- Add guards for OpenAI-style tool_calls detection

## Non-Goals

- V1 UI changes (V1 is legacy, kept as-is)
- New features beyond V1 parity (except OpenAI format support which is a bug fix)
- Session management changes (stays single-session per server lifetime)
- Backend format conversion (data stays in original format)

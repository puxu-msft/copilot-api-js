# Remaining Fixes — Work Tracker

## COMPLETED:
1. ✅ consumers.ts line 148-153: Added `cache_creation_input_tokens: r.usage.cache_creation_input_tokens`
2. ✅ store.ts: Added OpenAI tool_calls search in getHistory (after line ~408)
3. ✅ V1 script.js: Changed `s.removedBlockCount` → `s.totalBlocksRemoved` (2 occurrences around line 902-906)
4. ✅ V1 script.js: Added `cache_creation_input_tokens` display (after cache_read_input_tokens, around line 869)
5. ✅ Tests: 3 new tests in history-store.test.ts (cache_creation_input_tokens, 2x OpenAI search)
6. ✅ All 28 tests pass
7. ✅ Documentation: docs/history-system.md

## REMAINING:

### Fix 3c: V1 OpenAI tool_calls rendering
- File: `src/ui/history-v1/script.js`
- `renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap)` at line 1054
  - Currently only handles Anthropic ContentBlock array types (text, tool_use, tool_result, image, thinking)
  - Need to also pass the full message `msg` and render `msg.tool_calls` for OpenAI format
- `renderMessage()` at line 1188 calls `renderMessageContent(content, ...)` on lines 1260, 1264, 1274
  - All 3 call sites need to pass `msg` as 6th param
- Also line 764: `renderMessage({ role: "assistant", content: msgContent }, ...)` for response
  - The response content is extracted as `const msgContent = responseContent.content ?? responseContent`
  - `responseContent` is `currentEntry.response?.content` which is a MessageContent `{role, content, tool_calls?}`
  - So for response: need to pass the full responseContent, not just extract msgContent

**Implementation plan for Fix 3c:**
1. Add 6th param `msg` to `renderMessageContent`
2. At end of function (before return), if `msg?.tool_calls` exists, render them as tool_use blocks
3. Update 3 call sites in `renderMessage` (lines 1260, 1264, 1274) to pass `msg`
4. Fix response rendering (line 764): pass responseContent as full msg

### Fix 4: V3 SanitizationInfo type + MetaInfo
- File: `src/ui/history-v3/src/types/index.ts` line 86-89
  - Current: `{ removedBlockCount: number; systemReminderRemovals: number }`
  - Should be: `{ totalBlocksRemoved: number; orphanedToolUseCount: number; orphanedToolResultCount: number; fixedNameCount: number; emptyTextBlocksRemoved: number; systemReminderRemovals: number }`
- File: `src/ui/history-v3/src/components/detail/MetaInfo.vue` line 99-109
  - Change `entry.rewrites.sanitization.removedBlockCount` → `entry.rewrites.sanitization.totalBlocksRemoved`
  - Add display for orphanedToolUseCount, orphanedToolResultCount, fixedNameCount, emptyTextBlocksRemoved

### Final verification:
- Run `bun test` (all tests)
- Run `bun run typecheck`
- Run V3 build: `cd src/ui/history-v3 && bun run build`

# REMAINING EDITS — EXECUTE IMMEDIATELY

## COMPLETED in this round:
1. ✅ useHistoryStore.ts:336 — `entry.request.messages ?? []`
2. ✅ RequestItem.vue:29 — `|| '-'` fallback
3. ✅ MetaInfo.vue:21 — `|| '-'` fallback
4. ✅ MetaInfo.vue:33 — `=== true` check

## STILL TODO:

### Fix 5: MetaInfo.vue — cache optional chaining (lines 63, 67)
These are inside parent `v-if="entry.response?.usage"` but should be independently safe.

OLD line 63: `<div v-if="entry.response.usage.cache_read_input_tokens" class="meta-row">`
NEW line 63: `<div v-if="entry.response?.usage?.cache_read_input_tokens" class="meta-row">`

OLD line 67: `<div v-if="entry.response.usage.cache_creation_input_tokens" class="meta-row">`
NEW line 67: `<div v-if="entry.response?.usage?.cache_creation_input_tokens" class="meta-row">`

### Fix 6: MetaInfo.vue — sanitization optional chaining (lines 101, 105, 109, 113, 117)
These are inside parent `v-if="entry.rewrites?.sanitization"` but should be independently safe.

OLD pattern: `entry.rewrites.sanitization.X`
NEW pattern: `entry.rewrites?.sanitization?.X`

Lines to change:
- 101: `entry.rewrites.sanitization.totalBlocksRemoved` → `entry.rewrites?.sanitization?.totalBlocksRemoved`
- 105: `entry.rewrites.sanitization.orphanedToolUseCount` → `entry.rewrites?.sanitization?.orphanedToolUseCount`
- 109: `entry.rewrites.sanitization.orphanedToolResultCount` → `entry.rewrites?.sanitization?.orphanedToolResultCount`
- 113: `entry.rewrites.sanitization.emptyTextBlocksRemoved` → `entry.rewrites?.sanitization?.emptyTextBlocksRemoved`
- 117: `entry.rewrites.sanitization.systemReminderRemovals` → `entry.rewrites?.sanitization?.systemReminderRemovals`

## After all fixes:
```bash
cd /home/xp/src/copilot-api-js/src/ui/history-v3 && npx vite build
cd /home/xp/src/copilot-api-js && bun test
```

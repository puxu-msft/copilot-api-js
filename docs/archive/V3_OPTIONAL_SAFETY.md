# Remaining V3 Optional Safety Fixes

## COMPLETED:
- useHistoryStore.ts:336 — `entry.request.messages ?? []`

## TODO:

### Fix 2: RequestItem.vue:29 — model fallback
OLD: `<span class="item-model">{{ entry.response?.model || entry.request.model }}</span>`
NEW: `<span class="item-model">{{ entry.response?.model || entry.request.model || '-' }}</span>`

### Fix 3: MetaInfo.vue:21 — model fallback
OLD: `<span class="meta-value">{{ entry.response?.model || entry.request.model }}</span>`
NEW: `<span class="meta-value">{{ entry.response?.model || entry.request.model || '-' }}</span>`

### Fix 4: MetaInfo.vue:33 — stream check
OLD: `<span class="meta-value">{{ entry.request.stream ? 'Yes' : 'No' }}</span>`
NEW: `<span class="meta-value">{{ entry.request.stream === true ? 'Yes' : 'No' }}</span>`

### Fix 5: MetaInfo.vue:63 — cache_read optional chain
OLD: `<div v-if="entry.response.usage.cache_read_input_tokens" class="meta-row">`
NEW: `<div v-if="entry.response?.usage?.cache_read_input_tokens" class="meta-row">`

### Fix 6: MetaInfo.vue:67 — cache_creation optional chain
OLD: `<div v-if="entry.response.usage.cache_creation_input_tokens" class="meta-row">`
NEW: `<div v-if="entry.response?.usage?.cache_creation_input_tokens" class="meta-row">`

### Fix 7: MetaInfo.vue:101,105,109,113,117 — sanitization optional chain
Change all `entry.rewrites.sanitization.X` to `entry.rewrites?.sanitization?.X` in v-if conditions.

## After all fixes:
- `cd /home/xp/src/copilot-api-js/src/ui/history-v3 && npx vite build`
- `cd /home/xp/src/copilot-api-js && bun test`

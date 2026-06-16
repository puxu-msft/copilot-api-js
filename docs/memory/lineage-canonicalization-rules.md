---
name: lineage-canonicalization-rules
description: Empirical rules for canonicalizing Anthropic messages for lineage hashing — strip cache_control + system-reminder text blocks
metadata: 
  node_type: memory
  type: project
  originSessionId: 57046898-5fcc-4fee-b914-3b508f99e121
---

Verified 2026-06-15 against live history at localhost:4141:

For request-lineage prefix-hash to work in copilot-api, **messages must be canonicalized before hashing**. Minimum stripping:

1. **`cache_control` field** anywhere in the tree (Claude Code shifts the ephemeral breakpoint forward each turn; same logical message gets different cache_control across turns).
2. **`<system-reminder>` text blocks** in `messages[].content[]` (Claude Code injects per-turn reminders containing currentDate, MEMORY.md, "TodoWrite hasn't been used" nudges — these drift within a single conversation, even for `messages[0]`).

**Empirical results**:
- After stripping only `cache_control`: 8 consecutive turns of same conversation prefix-match perfectly (msgs 1→3→5→7→9→11→13→15→17).
- Without stripping system-reminder text: msg[0] hash drifts within same conversation (cluster of 57 entries shared boilerplate but msg[0] hash flipped between 5d60c9b2... and b1d3b44c... when CLAUDE.md content changed mid-conversation).
- After also stripping system-reminder text blocks: msg[0] hash stable across 3 sampled entries of same conversation → `3d6c3bffa4f3`.

**Tool_use_id reverse-link** signal also confirmed: when curr.messages[prev_n] is a user message containing tool_result, its tool_use_id matches one of prev's response tool_use ids (verified on 4 pairs). Provides cryptographic-strength confirmation when prefix match alone is ambiguous.

**Counter-example to watch**: ~100 entries / 5 clusters by first-msg-hash means even with strict canonicalization, multiple distinct conversations might share msg[0] (e.g., same `/init` boot prompt). Lineage must verify deeper prefix beyond just msg[0].

See [[empirical-probe-via-history-api]] for the probe methodology.

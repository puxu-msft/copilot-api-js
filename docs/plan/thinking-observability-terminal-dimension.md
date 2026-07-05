# Plan: model `thinking` observability as a per-request terminal dimension

> **实施状态：已完成**
> **落地**：ac7e4b0
> **现状锚点**：`src/lib/observability/sinks/console.ts`（entry.thinking 终态渲染）
> **备注**：按修订设计（fixed requested 源 + overwrite effective）落地；thinking-wire FeatureKind 已删

## Context

A successful request logs `( thinking:adaptive, thinking-wire:adaptive )` on the `[ OK ]` line. The pair is redundant when no coercion happened, and only carries signal when the two differ (old client sends `thinking:enabled` → an adaptive-only model coerces it → `thinking:enabled→adaptive`).

Root cause: a next-optimal data model. The "thinking" signal is recorded at **6 scattered sites** under **2 FeatureKinds** (`thinking` = requested, `thinking-wire` = effective/wire), each `{ type }` only, and these tags are **console-display-only** (history ignores `feature_applied`; ws forwards but the frontend union drops it; the persisted truth is `inbound/outboundRequest.payload.thinking`).

**Adversarial review (3 parallel agents) found the naive "merge into one feature emitted at the prepare-wire anchor reading `env.body`" design is wrong on the retry path — the highest-value diagnostic path.** Verified against code:
- **Retry mutates `env.body.thinking`.** `legacy-thinking-retry` returns `{...payload, thinking:{type:"adaptive"}}` (legacy-thinking-retry.ts:80-84); the driver sets `current = action.env` and re-runs `prepareWire(current)`. So reading `requested = env.body.thinking` yields **adaptive on attempt 1**, losing the fact the client asked for `enabled` — the coercion becomes invisible exactly where it matters.
- **Console tag accumulation is per-attempt + exact-string dedup** (console.ts:136-139, rendered at L294). Per-attempt emits with differing `effective` therefore pile up: `( thinking:enabled, thinking:adaptive )` — contradictory tags for one request.
- The `sampleRequest` capture is **shared**: `latestEffectiveMessages` still feeds retry message-mapping (handler-v4.ts:420). Only the `latestEffectiveThinking` slice is dead.

The correct model: **thinking is a per-request _terminal_ dimension** (it evolves across attempts via self-heal), not an accumulating event. `requested` must come from a **fixed source** (the client's original sanitized request, not the per-attempt body); `effective` is the **final** wire value (last attempt wins). The console must render it **once, as a terminal field**, not push a tag per attempt.

(Rejected alternative: derive thinking in console at completion directly from the payload — not viable; the console `completed` handler only has a lightweight `RequestContextSnapshot` (events.ts:66), which carries no inbound/outbound thinking. The feature-event channel is console's only access.)

## Design

**Data model** — single `thinking` feature, detail `{ requested?: string; effective: string }`; remove `thinking-wire` FeatureKind.
- `requested` = client's original sanitized thinking type, from a **fixed** source that does NOT drift across retries.
- `effective` = final outbound wire thinking type (post `coerceAdaptiveThinking`).

**Console = terminal field, not accumulated tag.** In the `feature_applied` handler, route `thinking` to a dedicated `entry.thinking` slot (set `requested` once; **overwrite** `effective` each attempt) instead of `entry.tags`. At completion, render it into the suffix:
- `requested && requested !== effective` → `thinking:${requested}→${effective}` (the `→` matches the existing `ws→http` convention).
- else → `thinking:${effective}`.

This fixes both review findings: overwrite semantics kill the cross-attempt contradiction; the fixed `requested` source keeps coercion attribution honest.

## Producers — fixed `requested`, final `effective`, per path

- **v4 driver path** — at the codec method that wraps `prepareAnthropicWire` (codec.ts:215, which CAN read the closure's `truncateBaseline`), emit `recordFeature("thinking", { requested: truncateBaseline?.thinking?.type, effective: wire.thinking?.type })`. **Crucially `requested` is `getTruncateBaseline()` (the initial sanitized payload, fixed), NOT `env.body`** (which retries mutate). Gate on `effective !== "disabled"`.
- **legacy adapter path** (web_search bypass + direct via `executeRequestPipeline`) — in `onPrepared` (pipeline.ts:145), emit `{ requested: anthropicPayload.thinking?.type, effective: wire.thinking?.type }` (`anthropicPayload` is the closure's fixed initial sanitized payload).

**Delete the 4 now-redundant sites** (the actual current kinds — the prior plan's labels were inverted; verify before deleting): `request-rewrites.ts:84` (emits `thinking`), `handler-v4.ts:455-458` (emits `thinking`, the slice in `recordRetryPipelineStateV4`), `web-search-direct.ts:228` and `:284` (emit `thinking`). The two prepare-anchor sites currently emit **`thinking-wire`** and are rewritten to emit the merged `thinking`.

**Dead-code scope (corrected from review):** remove ONLY the `latestEffectiveThinking` slice — the field (codec.ts:147), its getter `getLatestEffectiveThinking` (L192-193), and the `latestEffectiveThinking = sample.effectiveThinking` assignment (L221). **Keep `sampleAnthropicRequest`, `latestEffectiveMessages`, and the `effectiveMessages` capture** — still consumed by retry message-mapping (handler-v4.ts:420).

## Deferred (documented, not silently dropped)

- **type-only coverage.** `{requested, effective}` tracks only `thinking.type`. Coercions on other sub-dimensions are NOT surfaced: `adjustThinkingBudget` clamps `budget_tokens`, `clampEffortLevel` clamps `output_config.effort` (a sibling field, not in `thinking`), `coerceAdaptiveThinking` best_effort maps budget→effort. These are **not regressions** (today's `thinking-wire` is also type-only), but the merge does not fix them. Document as deferred; do NOT claim "single semantic dimension" in the FeatureKind doc — scope the wording to "top-level `thinking.type`, requested→effective".
- **`requested→disabled` blind spot.** The `effective !== "disabled"` gate drops the case where the client asked for thinking but the wire ended `disabled` (e.g. stripped). Pre-existing blind spot; document as deferred.

## Type + docs

- `events.ts` — remove `"thinking-wire"` from `FeatureKind`; rescope the `"thinking"` doc comment to `{ requested?, effective }` (top-level type only). No exhaustive `FeatureKind` switch exists (the `assertNever` switches are over `event.kind`), so removal is type-safe.
- `ws.ts`/frontend — no change.
- Docs: `docs/rfc/observability-rewrite.md` (FeatureKind table + the `anthropic/pipeline:147` mapping row) and `docs/rfc/p2.6-anthropic-driver-migration.md` ("wire-thinking feature" note).

## Tests

No existing test asserts this feature, so nothing breaks. Add:
- Export the thinking-render helper from `console.ts` (pure fn, minimal seam, mirrors the `retryMetaFeature` pattern) — unit-test: equal→`thinking:adaptive`; differ→`thinking:enabled→adaptive`; missing requested→`thinking:adaptive`.
- A console-sink test that **multiple `thinking` `feature_applied` events for one request collapse to ONE rendered tag** (terminal-overwrite, no cross-attempt contradiction) — the regression the review surfaced.

## Verification

- `bun run typecheck`; `bun run test:backend` green; new tests pass; `bunx eslint --fix` on changed files.
- Manual: a normal opus-4.8 request shows `thinking:adaptive` (single); an old `thinking:enabled` client → adaptive-only model shows `thinking:enabled→adaptive` (single, even across the legacy-thinking-retry); a multi-attempt request shows exactly one thinking tag.
- Re-run the 3 adversarial reviewers against the revised plan before implementing.

## Scope note

Display-only observability change (no history/wire/protocol behavior). Independent of the committed structured-outputs work. Larger than a one-case console tweak — it reshapes how console models the thinking signal (terminal field vs accumulated tag), which the review proved is necessary for retry correctness, not optional polish.

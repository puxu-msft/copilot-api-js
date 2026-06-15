# Activity Detail — Outline-as-Main Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invert Activity Detail page (`/activity/:id`) from "right-pane integral list of all messages" to "left-outline main + selection-driven slice/related on right (Pair / Cross-stage / JSON)".

**Architecture:** Strong-typed `Selection` discriminated union drives a `useOutlineSelection` composable; `useResolvedSelection` resolves Selection → fully-typed object with `'absent'` arm; SplitPane primitive (built in this plan) wraps left OutlineTree (virtualized via `v-virtual-scroll` over a flattened-with-depth list) and right `DetailLayout` (SelectedSlice on top, RelatedTabs below); 13 Slice* + 3 Related* components, each independent; sticky selection on j/k and StageTabs change via shape-preserving `DegradeOf<S>` ladder; cross-stage diff defaults driven by selected.stage semantics; failure-entry auto-selects `{kind:'metaError'}`. 9-commit cutover with provider rehoming (RawModal/MessageActions/ContentContext) into VDetailPage+DetailLayout.

**Tech Stack:** Vue 3 + Vuetify 4 + Vite (UI subdir); Pinia (setup store); bun test (`ui/tests/`) for composables/utils, vitest + `@vue/test-utils` + `mountWithVuetifyStubs` (`ui/vitest/`) for components; `@vueuse/core` (`useLocalStorage`, `onKeyStroke`); paths `@/*` → `ui/src/*`, `~backend/*` → `src/*`.

**Reference:** `docs/rfc/activity-detail-main-outline.md` v3.1 — Selection union §2.3, id table §2.3.1, sticky logic §2.4, provider rehoming §2.5, OutlineHeader §2.6, positionMap §2.7, cross-stage §2.8, ghost §2.9, virtualization §2.11, outline visual §2.12, keyboard §2.14, deferred §9.

---

## File Structure

### NEW files

```
ui/src/composables/
├── useOutlineSelection.ts     # Selection types, toId/fromId, sticky watchers, assertNever
├── useResolvedSelection.ts    # Selection → ResolvedSelection with 'absent' arm
└── useDiffModal.ts            # Module-singleton state for DiffModal (mirror useRawModal)

ui/src/components/ui/
└── SplitPane.vue              # Generic 2-pane resizable, useLocalStorage persist

ui/src/components/detail/
├── DetailLayout.vue           # SplitPane wrapper + provideMessageActions
├── outline/
│   ├── OutlineTree.vue        # v-virtual-scroll over flatNodes; emits 'select'
│   └── OutlineHeader.vue      # search placeholder + ?noauto pill
├── slice/
│   ├── SelectedSlice.vue      # switch(selection.kind) dispatcher + selection-flash CSS
│   ├── SliceStage.vue
│   ├── SliceSystem.vue
│   ├── SliceMessage.vue
│   ├── SliceBlock.vue
│   ├── SliceResponse.vue
│   ├── SliceResponseError.vue
│   ├── SliceResponseContent.vue
│   ├── SliceSseEvents.vue
│   ├── SliceHeaders.vue
│   ├── SliceAttempts.vue
│   ├── SliceAttempt.vue
│   ├── SliceMeta.vue
│   ├── SliceMetaError.vue
│   └── SliceAbsent.vue        # rendered when ResolvedSelection.kind === 'absent'
└── related/
    ├── RelatedTabs.vue        # v-tabs + v-window; active-tab-disabled fallback
    ├── RelatedPair.vue        # tool_use ↔ tool_result via toolMaps
    ├── RelatedCrossStage.vue  # semantic defaults + manual override
    ├── RelatedJson.vue        # raw JSON of selected node
    └── SideBySideSlice.vue    # 2-column diff wrapper (uses MessageDiffView/SseFrameDiff)

ui/tests/                       # bun tests
├── outline-selection.test.ts
├── resolved-selection.test.ts
├── tool-position-map.test.ts
├── cross-stage-pair.test.ts
└── flat-nodes.test.ts

tests/scripts/
└── selection-exhaustiveness.test.ts   # typecheck canary (out-of-tree mktemp copy)

ui/vitest/                      # vitest mount tests (one per new component)
└── (16 new test files: split-pane, outline-tree, outline-header, detail-layout,
   selected-slice, related-tabs, related-pair, related-cross-stage, related-json,
   slice-stage, slice-message, slice-block, slice-headers, slice-attempt,
   slice-meta-error, slice-response-error)
```

### MODIFIED files

| File | What changes |
|---|---|
| `ui/src/composables/useTocTree.ts` | Slim: keep `tocTree` + `expandedNodes` + `toggleNode`; ADD `flatNodes` computed; DELETE `scrollTo`/`ensureExpanded`/`activeId` + `toc-navigate` dispatcher. Rewrite `tocTree` to respect `activeStage` (request vs response subtrees + entry-global). Rename `id:"request"` (system leaf, line 88) → `"request.system"`; rename `id:"response"` (error leaf, line 123) → `"response.error"`. |
| `ui/src/composables/useDetailOrchestration.ts` | DELETE `filteredMessages` + `highlightBlock`; REWRITE `scrollToResult`/`scrollToCall` to call `selectByObject`; EXTEND `toolMaps` with `positionMap: Record<string, { use?: PerStageLoc; result?: PerStageLoc }>` populated in same single-pass scan. |
| `ui/src/composables/useDetailViewState.ts` | ADD `@deferred-rfc D2` JSDoc on `detailFilterRole/detailFilterType/showOnlyRewritten/aggregateTools`. |
| `ui/src/pages/vuetify/VDetailPage.vue` | REPLACE `<TocTree>` + `<DetailPanel>` two-column with `<DetailLayout>`; HOIST `<RawJsonModal>` + `<DiffModal>` to page level; CALL `provideRawModal()` + `provideContentContext()` here; instantiate `useOutlineSelection(entry, route, activeStage)`. |
| `ui/src/components/message/MessageBlock.vue` | DELETE `toc-navigate` listener (lines 53-58) + `handleTocNavigate`; DELETE ↔ button template (lines 202-209) + `onJump` (148-151) + `jumpToCounterpart` destructure (line 46). |
| `ui/src/components/detail/SectionBlock.vue` | DELETE `toc-navigate` listener (lines 48-53) + `handleTocNavigate`. |
| `ui/src/components/message/ToolUseBlock.vue` | DELETE `:id="'tool-use-' + block.id"` DOM anchor (line 87). |
| `ui/src/components/message/ToolResultBlock.vue` | DELETE `:id="'tool-result-' + block.tool_use_id"` DOM anchors (lines 56, 88). |
| `ui/src/composables/useMessageActions.ts` | DELETE entire file (openDiff folds into useDiffModal). |
| `ui/vitest/detail-components.test.ts` | DELETE jumpToCounterpart assertions (lines 121-150). |
| `tests/e2e-ui/vuetify-history.pw.ts` | UPDATE line 72 (`.detail-panel .detail-body` → `[data-testid='detail-scroll-container']`) and line 99 (`"detail-body"` className probe → `"detail-scroll-container"`). |
| `ui/CLAUDE.md` lines 141, 166, 180 | UPDATE render pipeline diagram; SplitPane "now exists"; remove "DetailPanel 过大" item. |
| `ui/README.md` lines 40, 110 | UPDATE DetailPanel references → DetailLayout. |
| `package.json` | ADD `"test:typecheck-exhaustiveness": "bun test tests/scripts/selection-exhaustiveness.test.ts"`. |
| `ui/eslint.config.*` | ADD `@typescript-eslint/switch-exhaustiveness-check` rule. |

### DELETED files (commit 6/7)

```
ui/src/components/detail/DetailPanel.vue
ui/src/components/detail/DetailToolbar.vue
ui/src/components/detail/DetailRequestSection.vue
ui/src/components/detail/DetailResponseSection.vue
ui/src/components/detail/HeadersSection.vue                           # already dead today
ui/src/components/detail/stages/                                       # entire dir (7 files)
ui/src/components/detail/TocTree.vue                                   # renamed → outline/OutlineTree.vue
ui/src/composables/useSharedResizeObserver.ts                          # dead (0 caller of provider)
ui/src/composables/useMessageActions.ts                                # folded into useDiffModal
ui/vitest/detail-request-section.test.ts                               # orphaned by DetailRequestSection deletion
```

---

## Commit Map (9 commits)

| # | Commit | RFC §3 invariant |
|---|---|---|
| 1a | `feat(detail): Selection types + useOutlineSelection + useResolvedSelection` | §3 row 1 |
| 1b | `feat(detail): useDiffModal` | §3 row 1b |
| 2 | `feat(ui): SplitPane primitive` | §3 row 2 |
| 3 | `feat(detail): Slice* + Related* + RelatedTabs` | §3 row 3 |
| 4 | `feat(detail): OutlineTree + OutlineHeader + DetailLayout + flatNodes` | §3 row 4 |
| 5 | `feat(detail): cutover — VDetailPage → DetailLayout` ← USER VALIDATION POINT | §3 row 5 |
| 6 | `refactor(detail): delete DetailPanel + Stage* + 8 more` | §3 row 6 |
| 7 | `refactor(detail): cleanup toc-navigate + jumpToCounterpart + useMessageActions fold` | §3 row 7 |
| 8 | `refactor(detail): cleanup orphan DOM anchors + composable docs` | §3 row 8 |

Each commit ends typecheck-green + `npm run test:ui` green. Commit 5 is the user-validation checkpoint — pause for user to exercise the UI before commits 6/7/8.

---

# Commit 1a: Selection types + useOutlineSelection + useResolvedSelection

**Goal:** Ship type-safe Selection union, stage-aware id↔Selection codec, sticky watchers, ResolvedSelection resolver — all without touching any rendering. Existing pages continue working (useTocTree still has scrollTo until commit 7).

### Task 1.1: Create useOutlineSelection.ts with Selection types and assertNever

**Files:**
- Create: `ui/src/composables/useOutlineSelection.ts`

- [ ] **Step 1: Write Selection union and helpers**

Create `ui/src/composables/useOutlineSelection.ts`:

```typescript
import {
  //
  ref,
  computed,
  watch,
  type ComputedRef,
  type Ref,
} from "vue"
import type { RouteLocationNormalizedLoaded, Router } from "vue-router"

import type { HistoryEntry } from "@/types"

// ─── Stage taxonomy ───

export type StageId = "inbound" | "effective" | "wire" | "upstream" | "forwarded" | "attempts" | "meta"
export type MainStage = Extract<StageId, "inbound" | "effective" | "wire" | "upstream" | "forwarded">
export type MessageBearingStage = Extract<StageId, "inbound" | "effective" | "wire">
export type ResponseSseStage = Extract<StageId, "upstream" | "forwarded">

// ─── Selection discriminated union ───

export type Selection =
  | { kind: "stage"; stage: MainStage }
  | { kind: "system"; stage: MessageBearingStage }
  | { kind: "message"; stage: MessageBearingStage; messageIndex: number }
  | { kind: "block"; stage: MessageBearingStage; messageIndex: number; blockIndex: number }
  | { kind: "response" }
  | { kind: "responseError" }
  | { kind: "responseContent" }
  | { kind: "sseList"; stage: ResponseSseStage }
  | { kind: "headers" }
  | { kind: "attempts" }
  | { kind: "attempt"; attemptIndex: number }
  | { kind: "meta" }
  | { kind: "metaError" }

// ─── Exhaustiveness guard ───

/** Compile-time exhaustive switch helper. Every `switch(selection.kind)` MUST end in `default: return assertNever(s)`. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled selection kind: ${JSON.stringify(x)}`)
}

// ─── Stage guards ───

export const isMessageBearing = (s: StageId): s is MessageBearingStage => s === "inbound" || s === "effective" || s === "wire"
export const isMainStage = (s: StageId): s is MainStage => s !== "attempts" && s !== "meta"
export const isResponseSse = (s: StageId): s is ResponseSseStage => s === "upstream" || s === "forwarded"

// ─── toId / fromId codec ───

export interface IdContext {
  activeStage: StageId
}

/** Convert Selection → string id (matches useTocTree's emitted ids, post-rename). */
export function toId(s: Selection): string {
  switch (s.kind) {
    case "stage":
      return s.stage === "inbound" || s.stage === "effective" || s.stage === "wire" ? "request" : "response"
    case "system":
      return "request.system"
    case "message":
      return `request.messages.${s.messageIndex}`
    case "block":
      return `request.messages.${s.messageIndex}.content.${s.blockIndex}`
    case "response":
      return "response"
    case "responseError":
      return "response.error"
    case "responseContent":
      return "response.content"
    case "sseList":
      return "section-sse-events"
    case "headers":
      return "httpHeaders"
    case "attempts":
      return "attempts"
    case "attempt":
      return `attempts.${s.attemptIndex}`
    case "meta":
      return "meta"
    case "metaError":
      return "meta.error"
    default:
      return assertNever(s)
  }
}

/** Convert string id + activeStage context → Selection. Returns null for unknown ids OR mismatched stage context. */
export function fromId(id: string, ctx: IdContext): Selection | null {
  // Stage-less kinds first (no context needed)
  if (id === "response") return { kind: "response" }
  if (id === "response.error") return { kind: "responseError" }
  if (id === "response.content") return { kind: "responseContent" }
  if (id === "httpHeaders") return { kind: "headers" }
  if (id === "attempts") return { kind: "attempts" }
  if (id === "meta") return { kind: "meta" }
  if (id === "meta.error") return { kind: "metaError" }

  const attemptMatch = /^attempts\.(\d+)$/.exec(id)
  if (attemptMatch) return { kind: "attempt", attemptIndex: Number(attemptMatch[1]) }

  // Stage-bearing kinds
  if (id === "section-sse-events") {
    return isResponseSse(ctx.activeStage) ? { kind: "sseList", stage: ctx.activeStage } : null
  }
  if (id === "request") {
    return isMessageBearing(ctx.activeStage) ? { kind: "stage", stage: ctx.activeStage } : null
  }
  if (id === "request.system") {
    return isMessageBearing(ctx.activeStage) ? { kind: "system", stage: ctx.activeStage } : null
  }
  const msgMatch = /^request\.messages\.(\d+)$/.exec(id)
  if (msgMatch) {
    return isMessageBearing(ctx.activeStage) ? { kind: "message", stage: ctx.activeStage, messageIndex: Number(msgMatch[1]) } : null
  }
  const blockMatch = /^request\.messages\.(\d+)\.content\.(\d+)$/.exec(id)
  if (blockMatch) {
    return isMessageBearing(ctx.activeStage)
      ? { kind: "block", stage: ctx.activeStage, messageIndex: Number(blockMatch[1]), blockIndex: Number(blockMatch[2]) }
      : null
  }
  return null
}
```

- [ ] **Step 2: Commit (types + codec only, no resolver yet)**

```bash
git add ui/src/composables/useOutlineSelection.ts
git commit -m "feat(detail): Selection union + toId/fromId codec + stage guards

Discriminated Selection with 13 variants + stage taxonomy
(StageId, MainStage, MessageBearingStage, ResponseSseStage).
toId/fromId pair with activeStage-context disambiguation.
assertNever for exhaustive switches.

Part of RFC v3.1 commit 1a (composable shell)."
```

### Task 1.2: Codec round-trip tests

**Files:**
- Create: `ui/tests/outline-selection.test.ts`

- [ ] **Step 1: Write round-trip tests for every Selection variant**

Create `ui/tests/outline-selection.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import type { Selection, IdContext } from "@/composables/useOutlineSelection"
import { fromId, toId } from "@/composables/useOutlineSelection"

const inboundCtx: IdContext = { activeStage: "inbound" }
const upstreamCtx: IdContext = { activeStage: "upstream" }

describe("toId/fromId round-trip", () => {
  test.each<Selection>([
    { kind: "stage", stage: "inbound" },
    { kind: "system", stage: "inbound" },
    { kind: "message", stage: "inbound", messageIndex: 3 },
    { kind: "block", stage: "inbound", messageIndex: 3, blockIndex: 2 },
    { kind: "stage", stage: "wire" },
  ])("MessageBearingStage variant round-trips with matching context: %o", (s) => {
    expect(fromId(toId(s), { activeStage: s.kind === "stage" ? s.stage : (s as { stage: string }).stage as never })).toEqual(s)
  })

  test.each<Selection>([
    { kind: "response" },
    { kind: "responseError" },
    { kind: "responseContent" },
    { kind: "headers" },
    { kind: "attempts" },
    { kind: "attempt", attemptIndex: 5 },
    { kind: "meta" },
    { kind: "metaError" },
  ])("stage-less variant round-trips regardless of context: %o", (s) => {
    expect(fromId(toId(s), inboundCtx)).toEqual(s)
  })

  test("sseList round-trips with ResponseSseStage context", () => {
    const s: Selection = { kind: "sseList", stage: "upstream" }
    expect(fromId(toId(s), upstreamCtx)).toEqual(s)
  })

  test("stage variant for response side (upstream)", () => {
    const s: Selection = { kind: "stage", stage: "upstream" }
    // toId returns "response" for upstream stage; fromId with upstream ctx... maps to {kind:'response'} (stage-less), not back to stage
    // This is intentional per RFC §2.3.1 — "response" id maps to {kind:'response'}, while {kind:'stage', stage:'upstream'} round-trips via the entry-global response root.
    // Documented divergence: response-side stage selections are addressed via {kind:'response'}, not {kind:'stage', stage:'upstream'}.
    expect(toId(s)).toBe("response")
    expect(fromId("response", upstreamCtx)).toEqual({ kind: "response" })
  })
})

describe("fromId with mismatched context", () => {
  test("request.* with response-side context returns null", () => {
    expect(fromId("request", upstreamCtx)).toBeNull()
    expect(fromId("request.messages.0", upstreamCtx)).toBeNull()
    expect(fromId("request.messages.0.content.0", upstreamCtx)).toBeNull()
    expect(fromId("request.system", upstreamCtx)).toBeNull()
  })

  test("section-sse-events with request-side context returns null", () => {
    expect(fromId("section-sse-events", inboundCtx)).toBeNull()
  })
})

describe("fromId with unknown id", () => {
  test("returns null", () => {
    expect(fromId("not-a-real-id", inboundCtx)).toBeNull()
    expect(fromId("", inboundCtx)).toBeNull()
    expect(fromId("request.messages.abc", inboundCtx)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests, expect all pass**

Run: `npm run test:ui:bun -- outline-selection`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/tests/outline-selection.test.ts
git commit -m "test(detail): outline-selection codec round-trip + context mismatch + unknown id

Covers all 13 Selection variants + stage-context disambiguation +
null fallback for unknown ids."
```

### Task 1.3: Add DegradeOf<S> conditional type and helper functions

**Files:**
- Modify: `ui/src/composables/useOutlineSelection.ts` (append)

- [ ] **Step 1: Append DegradeOf + degradeOnce + degradeUntilExists + resolveExists**

Append to `ui/src/composables/useOutlineSelection.ts`:

```typescript
// ─── Degrade ladder (sticky-selection fallback) ───

/** Compile-time mapping: which parent kind a given Selection degrades to. */
export type DegradeOf<S extends Selection> =
  S extends { kind: "block"; stage: infer St; messageIndex: infer I }
    ? { kind: "message"; stage: St & MessageBearingStage; messageIndex: I & number }
  : S extends { kind: "message"; stage: infer St }
    ? { kind: "stage"; stage: St & MainStage }
  : S extends { kind: "attempt" }
    ? { kind: "attempts" }
  : S extends {
      kind:
        | "system"
        | "stage"
        | "response"
        | "responseError"
        | "responseContent"
        | "sseList"
        | "headers"
        | "attempts"
        | "meta"
        | "metaError"
    }
    ? null
  : never

/** Single-step degrade. Returns null for kinds with no parent. */
export function degradeOnce<S extends Selection>(s: S): DegradeOf<S> | null {
  switch (s.kind) {
    case "block":
      return { kind: "message", stage: s.stage, messageIndex: s.messageIndex } as DegradeOf<S>
    case "message":
      return { kind: "stage", stage: s.stage } as DegradeOf<S>
    case "attempt":
      return { kind: "attempts" } as DegradeOf<S>
    default:
      return null
  }
}

/** Walk DegradeOf chain until a present-in-entry selection is found. Returns null if chain bottoms out. */
export function degradeUntilExists(s: Selection, entry: HistoryEntry): Selection | null {
  let cur: Selection | null = s
  while (cur && !resolveExists(cur, entry)) {
    cur = degradeOnce(cur) as Selection | null
  }
  return cur
}

/** Pure existence check: does this selection's referenced data exist in the entry? */
export function resolveExists(s: Selection, entry: HistoryEntry): boolean {
  switch (s.kind) {
    case "stage": {
      if (s.stage === "inbound") return Boolean(entry.inboundRequest)
      if (s.stage === "effective") return Boolean(entry.effectiveRequest)
      if (s.stage === "wire") return Boolean(entry.outboundRequest)
      if (s.stage === "upstream") return Boolean(entry.outboundResponse)
      if (s.stage === "forwarded") return Boolean(entry.inboundResponse)
      return false
    }
    case "system": {
      const req = stageRequest(entry, s.stage)
      return Boolean(req?.system)
    }
    case "message": {
      const req = stageRequest(entry, s.stage)
      return Boolean(req?.messages && req.messages[s.messageIndex])
    }
    case "block": {
      const req = stageRequest(entry, s.stage)
      const msg = req?.messages?.[s.messageIndex]
      return Boolean(msg && Array.isArray(msg.content) && msg.content[s.blockIndex])
    }
    case "response":
      return Boolean(entry.outboundResponse)
    case "responseError":
      return Boolean(entry.outboundResponse?.error)
    case "responseContent":
      return Boolean(entry.outboundResponse?.content)
    case "sseList": {
      if (s.stage === "upstream") return Boolean(entry.sseEvents?.length)
      // forwarded SSE lives on inboundResponse.sseEvents (forwarded-leg recording)
      return Boolean(entry.inboundResponse?.sseEvents?.length)
    }
    case "headers":
      return Boolean(entry.httpHeaders)
    case "attempts":
      return Boolean(entry.attempts?.length)
    case "attempt":
      return Boolean(entry.attempts && entry.attempts[s.attemptIndex])
    case "meta":
      return true // always present (entry-level metadata)
    case "metaError":
      return entry.state === "failed" || Boolean(entry.outboundResponse?.error) || Boolean(entry.attempts?.some((a) => a.error))
    default:
      return assertNever(s)
  }
}

function stageRequest(entry: HistoryEntry, stage: MessageBearingStage) {
  if (stage === "inbound") return entry.inboundRequest
  if (stage === "effective") return entry.effectiveRequest
  if (stage === "wire") return entry.outboundRequest
  return undefined
}
```

- [ ] **Step 2: Write resolveExists + degrade tests**

Append to `ui/tests/outline-selection.test.ts`:

```typescript
import type { HistoryEntry } from "@/types"
import { degradeOnce, degradeUntilExists, resolveExists } from "@/composables/useOutlineSelection"

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "e1",
    startedAt: 0,
    endpoint: "anthropic-messages",
    inboundRequest: { messages: [] },
    ...over,
  } as HistoryEntry
}

describe("resolveExists", () => {
  test("stage present when its request leg exists", () => {
    expect(resolveExists({ kind: "stage", stage: "inbound" }, entry())).toBe(true)
    expect(resolveExists({ kind: "stage", stage: "effective" }, entry())).toBe(false)
  })

  test("block requires messages[i].content[j]", () => {
    const e = entry({ inboundRequest: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as never] } })
    expect(resolveExists({ kind: "block", stage: "inbound", messageIndex: 0, blockIndex: 0 }, e)).toBe(true)
    expect(resolveExists({ kind: "block", stage: "inbound", messageIndex: 0, blockIndex: 5 }, e)).toBe(false)
    expect(resolveExists({ kind: "block", stage: "inbound", messageIndex: 9, blockIndex: 0 }, e)).toBe(false)
  })

  test("metaError when entry.state === 'failed' OR outboundResponse.error", () => {
    expect(resolveExists({ kind: "metaError" }, entry({ state: "failed" }))).toBe(true)
    expect(resolveExists({ kind: "metaError" }, entry({ outboundResponse: { success: false, model: "x", usage: {} as never, content: null, error: "oops" } }))).toBe(true)
    expect(resolveExists({ kind: "metaError" }, entry())).toBe(false)
  })
})

describe("degradeOnce", () => {
  test("block → message", () => {
    expect(degradeOnce({ kind: "block", stage: "inbound", messageIndex: 3, blockIndex: 2 })).toEqual({ kind: "message", stage: "inbound", messageIndex: 3 })
  })
  test("message → stage", () => {
    expect(degradeOnce({ kind: "message", stage: "inbound", messageIndex: 3 })).toEqual({ kind: "stage", stage: "inbound" })
  })
  test("attempt → attempts", () => {
    expect(degradeOnce({ kind: "attempt", attemptIndex: 0 })).toEqual({ kind: "attempts" })
  })
  test("stage-less / leaf kinds return null", () => {
    expect(degradeOnce({ kind: "headers" })).toBeNull()
    expect(degradeOnce({ kind: "stage", stage: "inbound" })).toBeNull()
  })
})

describe("degradeUntilExists", () => {
  test("walks block→message→stage until present", () => {
    const e = entry() // only inbound, no messages
    const out = degradeUntilExists({ kind: "block", stage: "inbound", messageIndex: 5, blockIndex: 0 }, e)
    expect(out).toEqual({ kind: "stage", stage: "inbound" })
  })

  test("returns null when chain bottoms out absent", () => {
    const e = entry({ inboundRequest: undefined as never })
    const out = degradeUntilExists({ kind: "block", stage: "inbound", messageIndex: 0, blockIndex: 0 }, e)
    expect(out).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests, expect all pass**

Run: `npm run test:ui:bun -- outline-selection`
Expected: All tests pass (including the new resolveExists/degradeOnce/degradeUntilExists groups).

- [ ] **Step 4: Commit**

```bash
git add ui/src/composables/useOutlineSelection.ts ui/tests/outline-selection.test.ts
git commit -m "feat(detail): DegradeOf<S> + degradeOnce + degradeUntilExists + resolveExists

Compile-time-typed degrade ladder (block→message→stage; attempt→attempts;
others→null) plus runtime existence check. Covers HistoryEntry's actual
field shape (no .meta — uses state/outboundResponse.error/attempts[].error)."
```

### Task 1.4: pickAutoSelect + sticky state + useOutlineSelection composable body

**Files:**
- Modify: `ui/src/composables/useOutlineSelection.ts` (append)

- [ ] **Step 1: Append pickAutoSelect + useOutlineSelection**

Append to `ui/src/composables/useOutlineSelection.ts`:

```typescript
// ─── Auto-select on entry mount ───

/** Pick the initial selection when entry loads (no user click yet). Per RFC §I6. */
export function pickAutoSelect(entry: HistoryEntry | null): Selection | null {
  if (!entry) return null
  if (entry.state === "failed") return { kind: "metaError" }
  if (entry.inboundRequest) return { kind: "stage", stage: "inbound" }
  if (entry.effectiveRequest) return { kind: "stage", stage: "effective" }
  if (entry.outboundRequest) return { kind: "stage", stage: "wire" }
  if (entry.outboundResponse) return { kind: "stage", stage: "upstream" }
  if (entry.inboundResponse) return { kind: "stage", stage: "forwarded" }
  return null
}

// ─── Composable ───

export interface UseOutlineSelectionReturn {
  selection: Ref<Selection | null>
  stickyIntent: Ref<Selection | null>
  selectedId: ComputedRef<string | null>
  stickyIntentId: ComputedRef<string | null>
  select: (id: string) => void
  selectByObject: (s: Selection | null) => void
  clear: () => void
}

/**
 * Selection state + sticky watchers + auto-select.
 *
 * Instantiate ONCE per VDetailPage mount. State lives per-mount (route leave
 * = lost — cross-mount persistence deferred per RFC §9 D3).
 */
export function useOutlineSelection(
  entryRef: Ref<HistoryEntry | null> | ComputedRef<HistoryEntry | null>,
  activeStageRef: Ref<StageId>,
  route: RouteLocationNormalizedLoaded,
): UseOutlineSelectionReturn {
  const selection = ref<Selection | null>(null)
  const stickyIntent = ref<Selection | null>(null)
  const firstLoadDone = ref(false)

  const noauto = computed(() => route.query.noauto === "1" || route.query.noauto === "true")

  const selectedId = computed(() => (selection.value ? toId(selection.value) : null))
  const stickyIntentId = computed(() => (stickyIntent.value && stickyIntent.value !== selection.value ? toId(stickyIntent.value) : null))

  function select(id: string): void {
    const s = fromId(id, { activeStage: activeStageRef.value })
    if (!s) {
      // eslint-disable-next-line no-console
      console.warn(`[useOutlineSelection] unknown id: ${id}`)
      return
    }
    selectByObject(s)
  }

  function selectByObject(s: Selection | null): void {
    selection.value = s
    stickyIntent.value = s
  }

  function clear(): void {
    selection.value = null
    stickyIntent.value = null
  }

  // Watch 1: Entry change (j/k)
  watch(
    entryRef,
    (newEntry) => {
      if (!newEntry) return

      if (noauto.value) {
        if (!firstLoadDone.value) selection.value = null
        firstLoadDone.value = true
        return
      }

      if (!firstLoadDone.value) {
        const auto = pickAutoSelect(newEntry)
        selection.value = auto
        stickyIntent.value = auto
        firstLoadDone.value = true
        return
      }

      if (selection.value == null) {
        const auto = pickAutoSelect(newEntry)
        selection.value = auto
        stickyIntent.value = auto
        return
      }

      // Sticky: try shape-preserving, else degrade
      stickyIntent.value = selection.value
      if (resolveExists(selection.value, newEntry)) return // already valid
      selection.value = degradeUntilExists(selection.value, newEntry)
    },
    { immediate: true },
  )

  // Watch 2: Stage change (StageTabs)
  watch(activeStageRef, (newStage) => {
    const cur = selection.value
    if (!cur) return
    if (!("stage" in cur)) return // headers/attempts/meta/response/responseError/responseContent/metaError unaffected
    stickyIntent.value = cur

    let remapped: Selection | null = null
    switch (cur.kind) {
      case "stage":
        remapped = isMainStage(newStage) ? { kind: "stage", stage: newStage } : null
        break
      case "system":
      case "message":
      case "block":
        if (isMessageBearing(newStage)) {
          remapped = { ...cur, stage: newStage }
        } else if (isMainStage(newStage)) {
          remapped = { kind: "stage", stage: newStage }
        }
        break
      case "sseList":
        if (isResponseSse(newStage)) {
          remapped = { kind: "sseList", stage: newStage }
        } else if (isMainStage(newStage)) {
          remapped = { kind: "stage", stage: newStage }
        }
        break
      default:
        // Compile-time exhaustiveness: every `stage`-bearing kind handled above.
        return assertNever(cur as never)
    }

    selection.value = remapped && entryRef.value && resolveExists(remapped, entryRef.value) ? remapped : isMainStage(newStage) ? { kind: "stage", stage: newStage } : null
  })

  return { selection, stickyIntent, selectedId, stickyIntentId, select, selectByObject, clear }
}
```

- [ ] **Step 2: Write composable behavior tests**

Append to `ui/tests/outline-selection.test.ts`:

```typescript
import { computed, ref } from "vue"
import type { RouteLocationNormalizedLoaded } from "vue-router"

import { pickAutoSelect, useOutlineSelection, type StageId } from "@/composables/useOutlineSelection"

function fakeRoute(query: Record<string, string> = {}): RouteLocationNormalizedLoaded {
  return { query } as RouteLocationNormalizedLoaded
}

describe("pickAutoSelect", () => {
  test("failed entry → metaError", () => {
    expect(pickAutoSelect(entry({ state: "failed" }))).toEqual({ kind: "metaError" })
  })
  test("success + inbound present → stage:inbound", () => {
    expect(pickAutoSelect(entry())).toEqual({ kind: "stage", stage: "inbound" })
  })
  test("inbound absent, effective present → stage:effective", () => {
    expect(pickAutoSelect(entry({ inboundRequest: undefined as never, effectiveRequest: { messages: [] } as never }))).toEqual({ kind: "stage", stage: "effective" })
  })
  test("nothing present → null", () => {
    expect(pickAutoSelect(entry({ inboundRequest: undefined as never }))).toBeNull()
  })
})

describe("useOutlineSelection", () => {
  test("auto-selects on first entry load", async () => {
    const entryRef = ref(entry())
    const stage = ref<StageId>("inbound")
    const sel = useOutlineSelection(entryRef, stage, fakeRoute())
    await Promise.resolve()
    expect(sel.selection.value).toEqual({ kind: "stage", stage: "inbound" })
  })

  test("noauto=1 keeps selection null on mount", async () => {
    const entryRef = ref(entry())
    const stage = ref<StageId>("inbound")
    const sel = useOutlineSelection(entryRef, stage, fakeRoute({ noauto: "1" }))
    await Promise.resolve()
    expect(sel.selection.value).toBeNull()
  })

  test("sticky: block selection in entry A degrades to message in entry B (block absent)", async () => {
    const entryA = entry({ inboundRequest: { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } as never] } })
    const entryB = entry({ inboundRequest: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] } as never] } })
    const entryRef = ref(entryA)
    const stage = ref<StageId>("inbound")
    const sel = useOutlineSelection(entryRef, stage, fakeRoute())
    await Promise.resolve()
    sel.selectByObject({ kind: "block", stage: "inbound", messageIndex: 0, blockIndex: 1 })
    entryRef.value = entryB
    await Promise.resolve()
    // blockIndex 1 absent in B → degrades to message; messageIndex 0 present
    expect(sel.selection.value).toEqual({ kind: "message", stage: "inbound", messageIndex: 0 })
    expect(sel.stickyIntent.value).toEqual({ kind: "block", stage: "inbound", messageIndex: 0, blockIndex: 1 })
  })

  test("stage change: message in inbound stays at same messageIndex in effective if present", async () => {
    const e = entry({
      inboundRequest: { messages: [{ role: "user", content: "a" } as never, { role: "user", content: "b" } as never] },
      effectiveRequest: { messages: [{ role: "user", content: "a'" } as never, { role: "user", content: "b'" } as never] } as never,
    })
    const entryRef = ref(e)
    const stage = ref<StageId>("inbound")
    const sel = useOutlineSelection(entryRef, stage, fakeRoute())
    await Promise.resolve()
    sel.selectByObject({ kind: "message", stage: "inbound", messageIndex: 1 })
    stage.value = "effective"
    await Promise.resolve()
    expect(sel.selection.value).toEqual({ kind: "message", stage: "effective", messageIndex: 1 })
  })

  test("stage change to response-side from message-bearing → falls back to stage", async () => {
    const e = entry({ outboundResponse: { success: true, model: "x", usage: {} as never, content: null } as never })
    const entryRef = ref(e)
    const stage = ref<StageId>("inbound")
    const sel = useOutlineSelection(entryRef, stage, fakeRoute())
    await Promise.resolve()
    sel.selectByObject({ kind: "message", stage: "inbound", messageIndex: 0 })
    stage.value = "upstream"
    await Promise.resolve()
    expect(sel.selection.value).toEqual({ kind: "stage", stage: "upstream" })
  })

  test("select() with unknown id warns and no-ops", async () => {
    const entryRef = ref(entry())
    const stage = ref<StageId>("inbound")
    const sel = useOutlineSelection(entryRef, stage, fakeRoute())
    await Promise.resolve()
    const before = sel.selection.value
    const warnSpy = (console.warn = () => {}) // silence (Bun test doesn't capture console by default)
    sel.select("not-a-real-id")
    expect(sel.selection.value).toBe(before)
    void warnSpy
  })
})
```

- [ ] **Step 3: Run tests, expect all pass**

Run: `npm run test:ui:bun -- outline-selection`
Expected: All tests pass.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck:ui`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/composables/useOutlineSelection.ts ui/tests/outline-selection.test.ts
git commit -m "feat(detail): useOutlineSelection composable with sticky + auto-select watchers

- pickAutoSelect (failed entry→metaError; else first present stage)
- Watch 1 (entry change): auto-select on first load; sticky shape-preserving
  degrade via degradeUntilExists; ?noauto=1 query disables auto-select
- Watch 2 (stage change): swap stage on stage-bearing kinds; fall back to
  {kind:'stage'} when narrowing fails; stage-less kinds unaffected
- Single-write guarantee (compute then assign once per event)

Tests cover all branches + cross-entry degrade + cross-stage swap + noauto."
```

### Task 1.5: useResolvedSelection composable

**Files:**
- Create: `ui/src/composables/useResolvedSelection.ts`

- [ ] **Step 1: Write ResolvedSelection union + resolver**

Create `ui/src/composables/useResolvedSelection.ts`:

```typescript
import {
  //
  computed,
  type ComputedRef,
  type Ref,
} from "vue"

import type { ContentBlock, HistoryEntry, MessageContent, SseEventRecord } from "@/types"

import {
  //
  assertNever,
  resolveExists,
  type MainStage,
  type MessageBearingStage,
  type ResponseSseStage,
  type Selection,
} from "./useOutlineSelection"

// ─── Resolved discriminated union (1:1 with Selection + 'absent' arm) ───

type SelOf<K extends Selection["kind"]> = Extract<Selection, { kind: K }>

export type ResolvedSelection =
  | { kind: "stage"; selection: SelOf<"stage">; stage: MainStage }
  | { kind: "system"; selection: SelOf<"system">; systemText: string | unknown }
  | { kind: "message"; selection: SelOf<"message">; message: MessageContent }
  | { kind: "block"; selection: SelOf<"block">; block: ContentBlock; message: MessageContent }
  | { kind: "response"; selection: SelOf<"response">; response: NonNullable<HistoryEntry["outboundResponse"]> }
  | { kind: "responseError"; selection: SelOf<"responseError">; error: string }
  | { kind: "responseContent"; selection: SelOf<"responseContent">; content: MessageContent }
  | { kind: "sseList"; selection: SelOf<"sseList">; events: Array<SseEventRecord>; stage: ResponseSseStage }
  | { kind: "headers"; selection: SelOf<"headers">; headers: NonNullable<HistoryEntry["httpHeaders"]> }
  | { kind: "attempts"; selection: SelOf<"attempts">; attempts: NonNullable<HistoryEntry["attempts"]> }
  | { kind: "attempt"; selection: SelOf<"attempt">; attempt: NonNullable<HistoryEntry["attempts"]>[number] }
  | { kind: "meta"; selection: SelOf<"meta">; entry: HistoryEntry }
  | { kind: "metaError"; selection: SelOf<"metaError">; error: string; source: "outboundResponse" | "lastAttempt" | "lifecycleState" }
  | { kind: "absent"; original: Selection }

function stageRequest(entry: HistoryEntry, stage: MessageBearingStage) {
  if (stage === "inbound") return entry.inboundRequest
  if (stage === "effective") return entry.effectiveRequest
  if (stage === "wire") return entry.outboundRequest
  return undefined
}

/** Resolve Selection → fully-typed ResolvedSelection. Returns null only when selection itself is null (no selection at all). 'absent' arm returned when selection points at missing data. */
export function useResolvedSelection(
  selectionRef: Ref<Selection | null>,
  entryRef: Ref<HistoryEntry | null>,
): ComputedRef<ResolvedSelection | null> {
  return computed(() => {
    const sel = selectionRef.value
    const entry = entryRef.value
    if (!sel || !entry) return null
    if (!resolveExists(sel, entry)) return { kind: "absent", original: sel }

    switch (sel.kind) {
      case "stage":
        return { kind: "stage", selection: sel, stage: sel.stage }
      case "system": {
        const req = stageRequest(entry, sel.stage)!
        return { kind: "system", selection: sel, systemText: req.system }
      }
      case "message": {
        const req = stageRequest(entry, sel.stage)!
        return { kind: "message", selection: sel, message: req.messages![sel.messageIndex] }
      }
      case "block": {
        const req = stageRequest(entry, sel.stage)!
        const msg = req.messages![sel.messageIndex]
        const block = (msg.content as Array<ContentBlock>)[sel.blockIndex]
        return { kind: "block", selection: sel, block, message: msg }
      }
      case "response":
        return { kind: "response", selection: sel, response: entry.outboundResponse! }
      case "responseError":
        return { kind: "responseError", selection: sel, error: entry.outboundResponse!.error! }
      case "responseContent":
        return { kind: "responseContent", selection: sel, content: entry.outboundResponse!.content! }
      case "sseList": {
        const events = sel.stage === "upstream" ? entry.sseEvents! : entry.inboundResponse!.sseEvents!
        return { kind: "sseList", selection: sel, events, stage: sel.stage }
      }
      case "headers":
        return { kind: "headers", selection: sel, headers: entry.httpHeaders! }
      case "attempts":
        return { kind: "attempts", selection: sel, attempts: entry.attempts! }
      case "attempt":
        return { kind: "attempt", selection: sel, attempt: entry.attempts![sel.attemptIndex] }
      case "meta":
        return { kind: "meta", selection: sel, entry }
      case "metaError": {
        if (entry.outboundResponse?.error) return { kind: "metaError", selection: sel, error: entry.outboundResponse.error, source: "outboundResponse" }
        const lastAttemptError = entry.attempts?.findLast?.((a) => a.error)?.error
        if (lastAttemptError) return { kind: "metaError", selection: sel, error: lastAttemptError, source: "lastAttempt" }
        return { kind: "metaError", selection: sel, error: `state=${entry.state ?? "unknown"}`, source: "lifecycleState" }
      }
      default:
        return assertNever(sel)
    }
  })
}
```

- [ ] **Step 2: Write resolver tests**

Create `ui/tests/resolved-selection.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { ref } from "vue"

import type { HistoryEntry } from "@/types"

import { useResolvedSelection } from "@/composables/useResolvedSelection"
import type { Selection } from "@/composables/useOutlineSelection"

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: "e", startedAt: 0, endpoint: "anthropic-messages", inboundRequest: { messages: [] }, ...over } as HistoryEntry
}

describe("useResolvedSelection", () => {
  test("returns null when selection is null", () => {
    const resolved = useResolvedSelection(ref<Selection | null>(null), ref<HistoryEntry | null>(entry()))
    expect(resolved.value).toBeNull()
  })

  test("returns 'absent' when target missing in entry", () => {
    const sel: Selection = { kind: "block", stage: "inbound", messageIndex: 5, blockIndex: 0 }
    const resolved = useResolvedSelection(ref<Selection | null>(sel), ref<HistoryEntry | null>(entry()))
    expect(resolved.value).toEqual({ kind: "absent", original: sel })
  })

  test("resolves block with concrete block + message reference", () => {
    const e = entry({ inboundRequest: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as never] } })
    const sel: Selection = { kind: "block", stage: "inbound", messageIndex: 0, blockIndex: 0 }
    const resolved = useResolvedSelection(ref<Selection | null>(sel), ref<HistoryEntry | null>(e))
    expect(resolved.value).toMatchObject({ kind: "block", block: { type: "text", text: "hi" } })
  })

  test("metaError source = outboundResponse when present", () => {
    const e = entry({ state: "failed", outboundResponse: { success: false, model: "x", usage: {} as never, content: null, error: "boom" } as never })
    const sel: Selection = { kind: "metaError" }
    const resolved = useResolvedSelection(ref<Selection | null>(sel), ref<HistoryEntry | null>(e))
    expect(resolved.value).toEqual({ kind: "metaError", selection: sel, error: "boom", source: "outboundResponse" })
  })

  test("metaError source = lifecycleState when no other error captured", () => {
    const e = entry({ state: "failed" })
    const sel: Selection = { kind: "metaError" }
    const resolved = useResolvedSelection(ref<Selection | null>(sel), ref<HistoryEntry | null>(e))
    expect(resolved.value).toEqual({ kind: "metaError", selection: sel, error: "state=failed", source: "lifecycleState" })
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npm run test:ui:bun -- resolved-selection && npm run typecheck:ui`
Expected: All tests pass; 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/composables/useResolvedSelection.ts ui/tests/resolved-selection.test.ts
git commit -m "feat(detail): useResolvedSelection — Selection → ResolvedSelection with 'absent' arm

1:1 mapping per Selection.kind + discriminated 'absent' for not-found.
metaError source field (outboundResponse | lastAttempt | lifecycleState)
gives SliceMetaError a typed origin to render.

Consumers switch(resolved.kind) and never re-walk MessageContent indices."
```

### Task 1.6: typecheck-canary exhaustiveness gate

**Files:**
- Create: `tests/scripts/selection-exhaustiveness.test.ts`
- Modify: `package.json` (add `test:typecheck-exhaustiveness` script)

- [ ] **Step 1: Add package.json script**

Find the `"test:e2e": ...` line in `package.json`. Add a new script after it:

```json
    "test:typecheck-exhaustiveness": "bun test tests/scripts/selection-exhaustiveness.test.ts",
```

- [ ] **Step 2: Write the canary test (mktemp copy mechanism)**

Create `tests/scripts/selection-exhaustiveness.test.ts`:

```typescript
import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workdirs: Array<string> = []

afterAll(() => {
  for (const d of workdirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test("adding a Selection variant must trigger compile errors at every consumer site", () => {
  const workdir = mkdtempSync(join(tmpdir(), "sel-canary-"))
  workdirs.push(workdir)

  // Copy ui/src and tsconfig out-of-tree
  cpSync("ui/src", join(workdir, "src"), { recursive: true })
  copyFileSync("ui/tsconfig.json", join(workdir, "tsconfig.json"))

  // Patch tsconfig paths to point at copied src
  const tsconfig = JSON.parse(readFileSync(join(workdir, "tsconfig.json"), "utf8")) as {
    compilerOptions?: { paths?: Record<string, Array<string>>; baseUrl?: string }
  }
  tsconfig.compilerOptions ??= {}
  tsconfig.compilerOptions.baseUrl = "."
  tsconfig.compilerOptions.paths = { "@/*": ["src/*"] }
  writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2))

  // Inject canary variant into Selection union
  const selPath = join(workdir, "src/composables/useOutlineSelection.ts")
  let sel = readFileSync(selPath, "utf8")
  sel = sel.replace(/(export type Selection =\s*\n)/, `$1  | { kind: "__canary" }\n`)
  writeFileSync(selPath, sel)

  // Run tsc against the patched copy
  const result = spawnSync("npx", ["--no-install", "tsc", "--noEmit", "--project", workdir], {
    encoding: "utf8",
  })

  expect(result.status).not.toBe(0)
  // Must mention at least these consumer files (added as new components/composables that switch on selection.kind)
  const expectedSites = ["useResolvedSelection", "toId", "fromId", "degradeOnce", "resolveExists"]
  const out = (result.stdout ?? "") + (result.stderr ?? "")
  for (const site of expectedSites) {
    expect(out).toContain(site)
  }
})
```

- [ ] **Step 3: Run the canary test**

Run: `npm run test:typecheck-exhaustiveness`
Expected: Test passes (tsc exits non-zero against patched Selection; output mentions every expected consumer site).

- [ ] **Step 4: Commit**

```bash
git add package.json tests/scripts/selection-exhaustiveness.test.ts
git commit -m "test(detail): typecheck-canary for Selection exhaustiveness

Spawns tsc against an out-of-tree mktemp copy of ui/src with a __canary
variant injected into Selection. Asserts non-zero exit + every consumer
site mentioned in errors. Cleanup via afterAll/rmSync.

Not in test:ui (heavyweight); dedicated test:typecheck-exhaustiveness
script. Run in CI."
```

---

# Commit 1b: useDiffModal

### Task 1b.1: Module-singleton diff modal state

**Files:**
- Create: `ui/src/composables/useDiffModal.ts`
- Create: `ui/tests/diff-modal-composable.test.ts`

- [ ] **Step 1: Write useDiffModal (module-singleton, mirrors useRawModal but no provide/inject)**

Create `ui/src/composables/useDiffModal.ts`:

```typescript
import {
  //
  ref,
  shallowRef,
  type Ref,
  type ShallowRef,
} from "vue"

import type { MessageContent } from "@/types"

// ─── Public API (module-scoped singleton) ───

export interface DiffModalState {
  visible: Ref<boolean>
  original: ShallowRef<MessageContent | null>
  effective: ShallowRef<MessageContent | null>
  label: Ref<string>
  open: (original: MessageContent, effective: MessageContent, label: string) => void
  close: () => void
}

const visible = ref(false)
const original = shallowRef<MessageContent | null>(null)
const effective = shallowRef<MessageContent | null>(null)
const label = ref("")

function open(o: MessageContent, e: MessageContent, l: string): void {
  original.value = o
  effective.value = e
  label.value = l
  visible.value = true
}

function close(): void {
  visible.value = false
}

const singleton: DiffModalState = { visible, original, effective, label, open, close }

/**
 * Module-singleton diff modal state. Mirrors useRawModal's pattern but uses
 * module scope instead of provide/inject — needed because DetailLayout
 * (provider of `provideMessageActions.openDiff`) and VDetailPage (mounts
 * `<DiffModal>`) sit at different points in the tree.
 */
export function useDiffModal(): DiffModalState {
  return singleton
}
```

- [ ] **Step 2: Write composable test**

Create `ui/tests/diff-modal-composable.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import type { MessageContent } from "@/types"

import { useDiffModal } from "@/composables/useDiffModal"

const msg = (text: string): MessageContent => ({ role: "user", content: [{ type: "text", text }] as never })

describe("useDiffModal", () => {
  test("singleton shares state across callers", () => {
    const a = useDiffModal()
    const b = useDiffModal()
    a.open(msg("o"), msg("e"), "label")
    expect(b.visible.value).toBe(true)
    expect(b.label.value).toBe("label")
    a.close()
    expect(b.visible.value).toBe(false)
  })
})
```

- [ ] **Step 3: Run test + typecheck**

Run: `npm run test:ui:bun -- diff-modal-composable && npm run typecheck:ui`
Expected: Test passes; 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/composables/useDiffModal.ts ui/tests/diff-modal-composable.test.ts
git commit -m "feat(detail): useDiffModal module-singleton (mirrors useRawModal)

Bridges DetailLayout (will provide openDiff via provideMessageActions) and
VDetailPage (will mount <DiffModal> bound to this singleton state).
Module scope instead of provide/inject — different ancestry."
```

---

# Commit 2: SplitPane primitive

### Task 2.1: SplitPane.vue with clamping, drag, persistence, keyboard, ARIA

**Files:**
- Create: `ui/src/components/ui/SplitPane.vue`

- [ ] **Step 1: Implement SplitPane.vue**

Create `ui/src/components/ui/SplitPane.vue`:

```vue
<script setup lang="ts">
import { useEventListener, useLocalStorage, useResizeObserver } from "@vueuse/core"
import { computed, ref, watch } from "vue"

interface Props {
  storageKey: string
  defaultLeftWidth?: number
  minLeftWidth?: number
  maxLeftWidth?: number
  collapseBelowViewport?: number
}

const props = withDefaults(defineProps<Props>(), {
  defaultLeftWidth: 480,
  minLeftWidth: 320,
  maxLeftWidth: 800,
  collapseBelowViewport: 768,
})

const emit = defineEmits<{ "resize-end": [px: number] }>()

const persisted = useLocalStorage<number>(props.storageKey, props.defaultLeftWidth)

const containerRef = ref<HTMLElement>()
const viewportWidth = ref(window.innerWidth)
useEventListener(window, "resize", () => {
  viewportWidth.value = window.innerWidth
})

const drawerMode = computed(() => viewportWidth.value < props.collapseBelowViewport)

function clamp(px: number): number {
  return Math.min(props.maxLeftWidth, Math.max(props.minLeftWidth, px))
}

// Initial clamp
persisted.value = clamp(persisted.value ?? props.defaultLeftWidth)

// Local drag state (not persisted until pointerup)
const dragging = ref(false)
const liveWidth = ref<number>(persisted.value)

watch(persisted, (v) => {
  if (!dragging.value) liveWidth.value = v
})

const leftStyle = computed(() => (drawerMode.value ? { width: "100%" } : { width: `${liveWidth.value}px` }))
const rightStyle = computed(() => (drawerMode.value ? { display: "none" } : {}))

function onPointerDown(e: PointerEvent): void {
  if (drawerMode.value) return
  e.preventDefault()
  dragging.value = true
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  ;(e.target as Element).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value || !containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  liveWidth.value = clamp(e.clientX - rect.left)
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  document.body.style.cursor = ""
  document.body.style.userSelect = ""
  ;(e.target as Element).releasePointerCapture?.(e.pointerId)
  persisted.value = liveWidth.value
  emit("resize-end", liveWidth.value)
}

function onKeyDown(e: KeyboardEvent): void {
  if (drawerMode.value) return
  const step = e.shiftKey ? 32 : 8
  if (e.key === "ArrowLeft") {
    e.preventDefault()
    liveWidth.value = clamp(liveWidth.value - step)
    persisted.value = liveWidth.value
    emit("resize-end", liveWidth.value)
  } else if (e.key === "ArrowRight") {
    e.preventDefault()
    liveWidth.value = clamp(liveWidth.value + step)
    persisted.value = liveWidth.value
    emit("resize-end", liveWidth.value)
  }
}

// Re-clamp on viewport shrink
watch(viewportWidth, () => {
  if (!drawerMode.value) {
    const clamped = clamp(liveWidth.value)
    if (clamped !== liveWidth.value) {
      liveWidth.value = clamped
      persisted.value = clamped
    }
  }
})

useResizeObserver(containerRef, () => {
  // no-op; ensures component reacts to container size changes
})
</script>

<template>
  <div
    ref="containerRef"
    class="split-pane"
    :class="{ 'drawer-mode': drawerMode }"
  >
    <div
      class="split-pane-left"
      :style="leftStyle"
    >
      <slot name="left" />
    </div>
    <div
      v-if="!drawerMode"
      class="split-pane-handle"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="liveWidth"
      :aria-valuemin="minLeftWidth"
      :aria-valuemax="maxLeftWidth"
      tabindex="0"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeyDown"
    >
      <div class="split-pane-handle-bar" />
    </div>
    <div
      class="split-pane-right"
      :style="rightStyle"
    >
      <slot name="right" />
    </div>
  </div>
</template>

<style scoped>
.split-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.split-pane.drawer-mode {
  display: block;
}

.split-pane-left {
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
}

.split-pane-right {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.split-pane-handle {
  flex-shrink: 0;
  width: 12px;
  margin: 0 -4px;
  cursor: col-resize;
  display: flex;
  align-items: stretch;
  justify-content: center;
  outline: none;
}

.split-pane-handle:focus-visible .split-pane-handle-bar {
  background: rgb(var(--v-theme-primary));
}

.split-pane-handle-bar {
  width: 4px;
  background: rgb(var(--v-theme-surface-variant));
  transition: background 0.15s ease;
}

.split-pane-handle:hover .split-pane-handle-bar {
  background: rgb(var(--v-theme-primary) / 60%);
}
</style>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:ui`
Expected: 0 errors.

- [ ] **Step 3: Update ui/CLAUDE.md line 166 (SplitPane stale doc)**

Read [ui/CLAUDE.md:166](ui/CLAUDE.md#L166) — find the line `- `SplitPane.vue` → `useLocalStorage`（面板宽度持久化）` (or similar) in the "VueUse 使用现状" section. Confirm it's correct now (the file exists). If it lists SplitPane under "刻意保留手写实现", move it to the "已使用 VueUse 替换" list. No file changes needed if already correct.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/ui/SplitPane.vue
git commit -m "feat(ui): SplitPane primitive — drag + keyboard + persist + drawer mode

Required for RFC commit 2. API:
- props: storageKey (required), defaultLeftWidth/min/max/collapseBelowViewport
- slots: #left, #right
- emits: resize-end (on pointerup or keydown only — not during drag)

Behavior: clamp on mount + on viewport resize; pointer events for touch +
mouse; body cursor lock during drag; ARIA role='separator' with arrow-key
resize (8px / Shift+32px); drawer mode below 768px hides right pane.
Persistence via useLocalStorage; only writes on resize-end (not 60Hz)."
```

### Task 2.2: SplitPane vitest

**Files:**
- Create: `ui/vitest/split-pane.test.ts`

- [ ] **Step 1: Write mount tests for SplitPane**

Create `ui/vitest/split-pane.test.ts`:

```typescript
import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import SplitPane from "@/components/ui/SplitPane.vue"

beforeEach(() => {
  localStorage.clear()
  // jsdom default innerWidth = 1024
})

afterEach(() => {
  localStorage.clear()
})

describe("SplitPane", () => {
  test("renders both slots", () => {
    const w = mount(SplitPane, {
      props: { storageKey: "test-split" },
      slots: { left: "<div data-testid='L'>L</div>", right: "<div data-testid='R'>R</div>" },
    })
    expect(w.find('[data-testid="L"]').exists()).toBe(true)
    expect(w.find('[data-testid="R"]').exists()).toBe(true)
  })

  test("defaults to defaultLeftWidth when no persisted value", () => {
    const w = mount(SplitPane, {
      props: { storageKey: "test-split-default", defaultLeftWidth: 500 },
      slots: { left: "L", right: "R" },
    })
    const left = w.find(".split-pane-left").element as HTMLElement
    expect(left.style.width).toBe("500px")
  })

  test("clamps persisted value to [min, max]", () => {
    localStorage.setItem("test-split-clamp", "9999")
    const w = mount(SplitPane, {
      props: { storageKey: "test-split-clamp", minLeftWidth: 200, maxLeftWidth: 600 },
      slots: { left: "L", right: "R" },
    })
    const left = w.find(".split-pane-left").element as HTMLElement
    expect(left.style.width).toBe("600px")
  })

  test("ARIA attributes on handle", () => {
    const w = mount(SplitPane, {
      props: { storageKey: "test-split-aria", defaultLeftWidth: 480 },
      slots: { left: "L", right: "R" },
    })
    const handle = w.find('[role="separator"]')
    expect(handle.exists()).toBe(true)
    expect(handle.attributes("aria-orientation")).toBe("vertical")
    expect(handle.attributes("aria-valuenow")).toBe("480")
    expect(handle.attributes("tabindex")).toBe("0")
  })

  test("ArrowRight emits resize-end with increased width", async () => {
    const w = mount(SplitPane, {
      props: { storageKey: "test-split-kbd", defaultLeftWidth: 480 },
      slots: { left: "L", right: "R" },
    })
    await w.find('[role="separator"]').trigger("keydown", { key: "ArrowRight" })
    expect(w.emitted("resize-end")?.[0]).toEqual([488])
  })

  test("Shift+ArrowLeft uses 32px step", async () => {
    const w = mount(SplitPane, {
      props: { storageKey: "test-split-kbd2", defaultLeftWidth: 480 },
      slots: { left: "L", right: "R" },
    })
    await w.find('[role="separator"]').trigger("keydown", { key: "ArrowLeft", shiftKey: true })
    expect(w.emitted("resize-end")?.[0]).toEqual([448])
  })
})
```

- [ ] **Step 2: Run vitest**

Run: `npm run test:ui:vitest -- split-pane`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/vitest/split-pane.test.ts
git commit -m "test(ui): SplitPane primitive — slots, clamp, ARIA, keyboard resize"
```

---

# Commit 3: Slice* + Related* components (unmounted)

> **Note:** Commit 3 ships 16 new components, each with one independent vitest. To keep this plan tractable, the tasks below show the FULL implementation for each component family, with one representative vitest each. The engineer creates each component + test as a sub-task; commits are batched per logical group (e.g. all Slice* in one commit, all Related* in one commit if too granular, or one commit per component family).

### Task 3.1: SliceAbsent.vue (universal fallback)

**Files:**
- Create: `ui/src/components/detail/slice/SliceAbsent.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import type { Selection } from "@/composables/useOutlineSelection"

defineProps<{
  originalKind: Selection["kind"]
}>()

const messages: Record<Selection["kind"], string> = {
  stage: "Stage absent",
  system: "System message absent at this stage",
  message: "Message absent at this stage; outline ghost shows original",
  block: "Block absent; degraded to parent message",
  response: "No upstream response",
  responseError: "No upstream error captured",
  responseContent: "No response content",
  sseList: "No SSE frames",
  headers: "No headers captured",
  attempts: "No attempts",
  attempt: "Attempt absent",
  meta: "No meta",
  metaError: "No error captured",
}
</script>

<template>
  <div class="slice-absent">
    <v-icon
      icon="mdi-information-outline"
      size="32"
      class="mb-2"
    />
    <div>{{ messages[originalKind] ?? "Selection absent" }}</div>
  </div>
</template>

<style scoped>
.slice-absent {
  padding: 32px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
}
</style>
```

### Task 3.2: SliceStage.vue (stage summary, NOT headers)

**Files:**
- Create: `ui/src/components/detail/slice/SliceStage.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed } from "vue"

import type { HistoryEntry } from "@/types"
import type { MainStage } from "@/composables/useOutlineSelection"

import { useHistoryStore } from "@/composables/useHistoryStore"

import SectionBlock from "../SectionBlock.vue"

const props = defineProps<{
  stage: MainStage
}>()

const store = useHistoryStore()
const entry = computed<HistoryEntry | null>(() => store.selectedEntry)

const stageData = computed(() => {
  const e = entry.value
  if (!e) return null
  switch (props.stage) {
    case "inbound":
      return { req: e.inboundRequest, resp: undefined }
    case "effective":
      return { req: e.effectiveRequest, resp: undefined }
    case "wire":
      return { req: e.outboundRequest, resp: undefined }
    case "upstream":
      return { req: undefined, resp: e.outboundResponse }
    case "forwarded":
      return { req: undefined, resp: e.inboundResponse }
  }
})

const messageCount = computed(() => stageData.value?.req?.messages?.length ?? 0)
const roleCounts = computed(() => {
  const map: Record<string, number> = {}
  for (const m of stageData.value?.req?.messages ?? []) {
    map[m.role] = (map[m.role] ?? 0) + 1
  }
  return map
})
const toolCount = computed(() => stageData.value?.req?.tools?.length ?? 0)
const sseCount = computed(() => {
  if (props.stage === "upstream") return entry.value?.sseEvents?.length ?? 0
  if (props.stage === "forwarded") return entry.value?.inboundResponse?.sseEvents?.length ?? 0
  return 0
})
const responseError = computed(() => entry.value?.outboundResponse?.error)
</script>

<template>
  <SectionBlock :title="`${stage} — stage summary`">
    <dl class="stage-summary">
      <template v-if="messageCount > 0">
        <dt>messages</dt>
        <dd>{{ messageCount }} ({{ Object.entries(roleCounts).map(([r, n]) => `${r}:${n}`).join(", ") }})</dd>
      </template>
      <template v-if="toolCount > 0">
        <dt>tools</dt>
        <dd>{{ toolCount }}</dd>
      </template>
      <template v-if="sseCount > 0">
        <dt>SSE frames</dt>
        <dd>{{ sseCount }}</dd>
      </template>
      <template v-if="responseError && (stage === 'upstream' || stage === 'forwarded')">
        <dt>error</dt>
        <dd class="text-error">{{ responseError }}</dd>
      </template>
    </dl>
  </SectionBlock>
</template>

<style scoped>
.stage-summary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  padding: 8px 0;
}
.stage-summary dt {
  font-weight: 600;
  color: rgb(var(--v-theme-on-surface-variant));
}
</style>
```

### Task 3.3: SliceMessage / SliceBlock / SliceSystem (thin wrappers)

**Files:**
- Create: `ui/src/components/detail/slice/SliceMessage.vue`
- Create: `ui/src/components/detail/slice/SliceBlock.vue`
- Create: `ui/src/components/detail/slice/SliceSystem.vue`

- [ ] **Step 1: SliceMessage.vue**

```vue
<script setup lang="ts">
import type { MessageContent } from "@/types"
import type { MessageBearingStage } from "@/composables/useOutlineSelection"

import MessageBlock from "@/components/message/MessageBlock.vue"

defineProps<{
  message: MessageContent
  messageIndex: number
  stage: MessageBearingStage
}>()
</script>

<template>
  <MessageBlock
    :message="message"
    :index="messageIndex"
  />
</template>
```

- [ ] **Step 2: SliceBlock.vue**

```vue
<script setup lang="ts">
import type { ContentBlock } from "@/types"

import ContentRenderer from "@/components/message/ContentRenderer.vue"

defineProps<{
  block: ContentBlock
  blockIndex: number
}>()
</script>

<template>
  <ContentRenderer
    :content="block"
    :index="blockIndex"
  />
</template>
```

- [ ] **Step 3: SliceSystem.vue**

```vue
<script setup lang="ts">
import type { MessageContent } from "@/types"

import SystemMessage from "@/components/message/SystemMessage.vue"

defineProps<{
  systemText: string | MessageContent["content"]
}>()
</script>

<template>
  <SystemMessage :system="systemText as never" />
</template>
```

### Task 3.4: SliceHeaders / SliceSseEvents / SliceMeta / SliceAttempts / SliceAttempt

**Files:**
- Create each in `ui/src/components/detail/slice/`

- [ ] **Step 1: SliceHeaders.vue** (uses HeadersComparisonSection, all stages)

```vue
<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import HeadersComparisonSection from "@/components/detail/HeadersComparisonSection.vue"

defineProps<{
  headers: NonNullable<HistoryEntry["httpHeaders"]>
}>()
</script>

<template>
  <HeadersComparisonSection
    :inbound-request="headers.inboundRequest"
    :outbound-request="headers.outboundRequest"
    :outbound-response="headers.outboundResponse"
    :inbound-response="headers.inboundResponse"
  />
</template>
```

(If `HeadersComparisonSection` doesn't accept these 4 props, fall back to passing only what it accepts and check its current API before this task.)

- [ ] **Step 2: SliceSseEvents.vue**

```vue
<script setup lang="ts">
import type { SseEventRecord } from "@/types"
import type { ResponseSseStage } from "@/composables/useOutlineSelection"

import SseEventsSection from "@/components/detail/SseEventsSection.vue"

defineProps<{
  events: Array<SseEventRecord>
  stage: ResponseSseStage
}>()
</script>

<template>
  <SseEventsSection :events="events" />
</template>
```

- [ ] **Step 3: SliceMeta.vue**

```vue
<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import MetaInfo from "@/components/detail/MetaInfo.vue"

defineProps<{
  entry: HistoryEntry
}>()
</script>

<template>
  <MetaInfo :entry="entry" />
</template>
```

- [ ] **Step 4: SliceAttempts.vue**

```vue
<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import AttemptsTimeline from "@/components/detail/AttemptsTimeline.vue"

defineProps<{
  attempts: NonNullable<HistoryEntry["attempts"]>
}>()
</script>

<template>
  <AttemptsTimeline :attempts="attempts" />
</template>
```

- [ ] **Step 5: SliceAttempt.vue**

```vue
<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import SectionBlock from "@/components/detail/SectionBlock.vue"

defineProps<{
  attempt: NonNullable<HistoryEntry["attempts"]>[number]
}>()
</script>

<template>
  <SectionBlock :title="`Attempt #${attempt.index + 1}`">
    <dl class="attempt-detail">
      <dt>strategy</dt><dd>{{ attempt.strategy ?? "n/a" }}</dd>
      <dt>duration</dt><dd>{{ attempt.durationMs }}ms</dd>
      <dt>transport</dt><dd>{{ attempt.transport ?? "n/a" }}</dd>
      <dt v-if="attempt.error">error</dt><dd
        v-if="attempt.error"
        class="text-error"
      >{{ attempt.error }}</dd>
    </dl>
  </SectionBlock>
</template>

<style scoped>
.attempt-detail {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
}
.attempt-detail dt { font-weight: 600; }
</style>
```

### Task 3.5: SliceResponse / SliceResponseError / SliceResponseContent / SliceMetaError

**Files:**
- Create each in `ui/src/components/detail/slice/`

- [ ] **Step 1: SliceResponse.vue**

```vue
<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import SectionBlock from "@/components/detail/SectionBlock.vue"

defineProps<{
  response: NonNullable<HistoryEntry["outboundResponse"]>
}>()
</script>

<template>
  <SectionBlock title="Upstream response">
    <dl class="resp-summary">
      <dt>success</dt><dd>{{ response.success }}</dd>
      <dt>model</dt><dd>{{ response.model }}</dd>
      <dt v-if="response.stop_reason">stop_reason</dt><dd v-if="response.stop_reason">{{ response.stop_reason }}</dd>
      <dt v-if="response.status">status</dt><dd v-if="response.status">{{ response.status }}</dd>
      <dt v-if="response.error">error</dt><dd
        v-if="response.error"
        class="text-error"
      >{{ response.error }}</dd>
    </dl>
  </SectionBlock>
</template>

<style scoped>
.resp-summary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
}
.resp-summary dt { font-weight: 600; }
</style>
```

- [ ] **Step 2: SliceResponseError.vue**

```vue
<script setup lang="ts">
import SectionBlock from "@/components/detail/SectionBlock.vue"

defineProps<{ error: string }>()
</script>

<template>
  <SectionBlock title="Upstream error">
    <pre class="error-body">{{ error }}</pre>
  </SectionBlock>
</template>

<style scoped>
.error-body {
  white-space: pre-wrap;
  word-break: break-word;
  color: rgb(var(--v-theme-error));
  font-family: var(--font-mono, monospace);
  padding: 12px;
}
</style>
```

- [ ] **Step 3: SliceResponseContent.vue**

```vue
<script setup lang="ts">
import type { MessageContent } from "@/types"

import MessageBlock from "@/components/message/MessageBlock.vue"

defineProps<{ content: MessageContent }>()
</script>

<template>
  <MessageBlock
    :message="content"
    :index="0"
  />
</template>
```

- [ ] **Step 4: SliceMetaError.vue**

```vue
<script setup lang="ts">
import SectionBlock from "@/components/detail/SectionBlock.vue"

defineProps<{
  error: string
  source: "outboundResponse" | "lastAttempt" | "lifecycleState"
}>()

const sourceLabel: Record<string, string> = {
  outboundResponse: "Upstream response error",
  lastAttempt: "Last attempt error",
  lifecycleState: "Lifecycle state",
}
</script>

<template>
  <SectionBlock :title="sourceLabel[source]">
    <pre class="error-body">{{ error }}</pre>
  </SectionBlock>
</template>

<style scoped>
.error-body {
  white-space: pre-wrap;
  word-break: break-word;
  color: rgb(var(--v-theme-error));
  font-family: var(--font-mono, monospace);
  padding: 12px;
}
</style>
```

### Task 3.6: SelectedSlice.vue dispatcher

**Files:**
- Create: `ui/src/components/detail/slice/SelectedSlice.vue`

- [ ] **Step 1: Implement dispatcher**

```vue
<script setup lang="ts">
import { ref, watch } from "vue"

import { assertNever } from "@/composables/useOutlineSelection"
import { useResolvedSelection, type ResolvedSelection } from "@/composables/useResolvedSelection"
import { useHistoryStore } from "@/composables/useHistoryStore"

import SliceAbsent from "./SliceAbsent.vue"
import SliceAttempt from "./SliceAttempt.vue"
import SliceAttempts from "./SliceAttempts.vue"
import SliceBlock from "./SliceBlock.vue"
import SliceHeaders from "./SliceHeaders.vue"
import SliceMessage from "./SliceMessage.vue"
import SliceMeta from "./SliceMeta.vue"
import SliceMetaError from "./SliceMetaError.vue"
import SliceResponse from "./SliceResponse.vue"
import SliceResponseContent from "./SliceResponseContent.vue"
import SliceResponseError from "./SliceResponseError.vue"
import SliceSseEvents from "./SliceSseEvents.vue"
import SliceStage from "./SliceStage.vue"
import SliceSystem from "./SliceSystem.vue"

import type { Ref } from "vue"
import type { Selection } from "@/composables/useOutlineSelection"

const props = defineProps<{
  selection: Selection | null
  entry: import("@/types").HistoryEntry | null
}>()

const selectionRef: Ref<Selection | null> = ref(props.selection)
const entryRef: Ref<import("@/types").HistoryEntry | null> = ref(props.entry)
watch(() => props.selection, (s) => { selectionRef.value = s })
watch(() => props.entry, (e) => { entryRef.value = e })

const resolved = useResolvedSelection(selectionRef, entryRef)

// Selection-change flash
const flashKey = ref(0)
watch(() => props.selection, () => { flashKey.value += 1 })

const _store = useHistoryStore() // ensure store reactivity (read by Slice* via composables)
void _store
</script>

<template>
  <div
    v-if="resolved == null"
    class="slice-placeholder"
  >
    Select a node from the outline to view details.
  </div>
  <div
    v-else
    :key="flashKey"
    class="selected-slice selection-flash"
  >
    <template v-if="(resolved as ResolvedSelection).kind === 'absent'">
      <SliceAbsent :original-kind="(resolved as Extract<ResolvedSelection, {kind:'absent'}>).original.kind" />
    </template>
    <template v-else>
      <component
        :is="dispatch(resolved)"
        v-bind="dispatchProps(resolved)"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, h, type Component } from "vue"

function dispatch(r: ResolvedSelection): Component {
  switch (r.kind) {
    case "stage": return SliceStage
    case "system": return SliceSystem
    case "message": return SliceMessage
    case "block": return SliceBlock
    case "response": return SliceResponse
    case "responseError": return SliceResponseError
    case "responseContent": return SliceResponseContent
    case "sseList": return SliceSseEvents
    case "headers": return SliceHeaders
    case "attempts": return SliceAttempts
    case "attempt": return SliceAttempt
    case "meta": return SliceMeta
    case "metaError": return SliceMetaError
    case "absent": return defineComponent({ render: () => h("div") })  // handled in template
    default: return assertNever(r)
  }
}

function dispatchProps(r: ResolvedSelection): Record<string, unknown> {
  switch (r.kind) {
    case "stage": return { stage: r.stage }
    case "system": return { systemText: r.systemText }
    case "message": return { message: r.message, messageIndex: r.selection.messageIndex, stage: r.selection.stage }
    case "block": return { block: r.block, blockIndex: r.selection.blockIndex }
    case "response": return { response: r.response }
    case "responseError": return { error: r.error }
    case "responseContent": return { content: r.content }
    case "sseList": return { events: r.events, stage: r.stage }
    case "headers": return { headers: r.headers }
    case "attempts": return { attempts: r.attempts }
    case "attempt": return { attempt: r.attempt }
    case "meta": return { entry: r.entry }
    case "metaError": return { error: r.error, source: r.source }
    case "absent": return {}
    default: return assertNever(r)
  }
}
</script>

<style scoped>
.slice-placeholder {
  padding: 64px 32px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  font-style: italic;
}

.selected-slice {
  padding: 16px;
}

@keyframes slice-flash {
  0% { background: rgb(var(--v-theme-primary) / 12%); }
  100% { background: transparent; }
}
.selection-flash {
  animation: slice-flash 600ms ease-out;
}
</style>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:ui`
Expected: 0 errors.

- [ ] **Step 3: Commit Slice* batch**

```bash
git add ui/src/components/detail/slice/
git commit -m "feat(detail): Slice* (13) + SelectedSlice dispatcher

13 slice components (Stage/System/Message/Block/Response/ResponseError/
ResponseContent/SseEvents/Headers/Attempts/Attempt/Meta/MetaError) +
universal SliceAbsent fallback + SelectedSlice exhaustive dispatcher with
selection-flash CSS animation.

Each slice composes existing kept components (MessageBlock/ContentRenderer/
SystemMessage/HeadersComparisonSection/SseEventsSection/MetaInfo/
AttemptsTimeline) — no rendering logic duplicated."
```

### Task 3.7: RelatedJson.vue (always-enabled tab)

**Files:**
- Create: `ui/src/components/detail/related/RelatedJson.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed } from "vue"

import type { HistoryEntry } from "@/types"
import type { ResolvedSelection } from "@/composables/useResolvedSelection"

import JsonViewerSurface from "@/components/ui/JsonViewerSurface.vue"

const props = defineProps<{
  resolved: ResolvedSelection | null
  entry: HistoryEntry | null
}>()

const jsonData = computed<unknown>(() => {
  const r = props.resolved
  if (!r) return null
  switch (r.kind) {
    case "absent": return { absent: true, original: r.original }
    case "stage": return { kind: r.kind, stage: r.stage }
    case "system": return r.systemText
    case "message": return r.message
    case "block": return r.block
    case "response": return r.response
    case "responseError": return { error: r.error }
    case "responseContent": return r.content
    case "sseList": return r.events
    case "headers": return r.headers
    case "attempts": return r.attempts
    case "attempt": return r.attempt
    case "meta": return r.entry
    case "metaError": return { error: r.error, source: r.source }
    default: {
      const _exhaustive: never = r
      return _exhaustive
    }
  }
})
</script>

<template>
  <div class="related-json">
    <JsonViewerSurface
      v-if="jsonData != null"
      :data="jsonData"
    />
    <div
      v-else
      class="related-empty"
    >No selection</div>
  </div>
</template>

<style scoped>
.related-json { padding: 8px; }
.related-empty { padding: 24px; text-align: center; color: rgb(var(--v-theme-on-surface-variant)); }
</style>
```

### Task 3.8: RelatedPair.vue (tool_use ↔ tool_result)

**Files:**
- Create: `ui/src/components/detail/related/RelatedPair.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed } from "vue"

import type { ContentBlock } from "@/types"
import type { ResolvedSelection } from "@/composables/useResolvedSelection"

import { isToolResultBlock, isToolUseBlock } from "@/utils/typeGuards"
import ContentRenderer from "@/components/message/ContentRenderer.vue"
import SectionBlock from "@/components/detail/SectionBlock.vue"

const props = defineProps<{
  resolved: ResolvedSelection | null
  toolMaps: {
    resultMap: Record<string, ContentBlock>
    nameMap: Record<string, string>
  }
}>()

const applicable = computed(() => {
  const r = props.resolved
  if (!r || r.kind !== "block") return false
  return isToolUseBlock(r.block) || isToolResultBlock(r.block)
})

const selfBlock = computed<ContentBlock | null>(() => {
  const r = props.resolved
  if (!r || r.kind !== "block") return null
  return r.block
})

const counterpart = computed<ContentBlock | null>(() => {
  const b = selfBlock.value
  if (!b) return null
  if (isToolUseBlock(b)) return props.toolMaps.resultMap[b.id] ?? null
  if (isToolResultBlock(b)) {
    // find tool_use by scanning nameMap reverse — but we don't have a use-map; the simpler approach
    // is to surface "no use found" if positionMap doesn't have it. For now, search via nameMap inversion:
    return null // RelatedPair pairs result→use need positionMap (Task 4); for v1 we render use→result only
  }
  return null
})
</script>

<template>
  <div
    v-if="!applicable"
    class="related-disabled"
  >Pair view applies to tool_use / tool_result blocks only.</div>
  <div
    v-else
    class="related-pair"
  >
    <SectionBlock title="Selected">
      <ContentRenderer
        :content="selfBlock!"
        :index="0"
      />
    </SectionBlock>
    <SectionBlock
      v-if="counterpart"
      title="Counterpart"
    >
      <ContentRenderer
        :content="counterpart"
        :index="0"
      />
    </SectionBlock>
    <div
      v-else
      class="no-pair"
    >No counterpart found in entry.</div>
  </div>
</template>

<style scoped>
.related-pair { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.related-disabled, .no-pair { padding: 24px; text-align: center; color: rgb(var(--v-theme-on-surface-variant)); }
</style>
```

### Task 3.9: RelatedCrossStage.vue + SideBySideSlice.vue

**Files:**
- Create: `ui/src/components/detail/related/RelatedCrossStage.vue`
- Create: `ui/src/components/detail/related/SideBySideSlice.vue`

- [ ] **Step 1: SideBySideSlice.vue (2-column generic wrapper)**

```vue
<script setup lang="ts">
defineProps<{
  leftLabel: string
  rightLabel: string
}>()
</script>

<template>
  <div class="side-by-side">
    <div class="side">
      <div class="side-label">{{ leftLabel }}</div>
      <div class="side-body"><slot name="left" /></div>
    </div>
    <div class="side">
      <div class="side-label">{{ rightLabel }}</div>
      <div class="side-body"><slot name="right" /></div>
    </div>
  </div>
</template>

<style scoped>
.side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px; }
.side { border: 1px solid rgb(var(--v-theme-surface-variant)); border-radius: 4px; }
.side-label { padding: 4px 8px; background: rgb(var(--v-theme-surface-variant) / 40%); font-weight: 600; font-size: 0.8rem; }
.side-body { padding: 8px; }
</style>
```

- [ ] **Step 2: RelatedCrossStage.vue (semantic pair defaults)**

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue"

import type { HistoryEntry, MessageContent } from "@/types"
import type { ResolvedSelection } from "@/composables/useResolvedSelection"
import type { MainStage, ResponseSseStage, Selection, StageId } from "@/composables/useOutlineSelection"

import MessageBlock from "@/components/message/MessageBlock.vue"

import SideBySideSlice from "./SideBySideSlice.vue"

const props = defineProps<{
  resolved: ResolvedSelection | null
  entry: HistoryEntry | null
  activeStage: StageId
}>()

interface PairChoice { left: StageId; right: StageId }

function defaultPair(activeStage: StageId): PairChoice | null {
  switch (activeStage) {
    case "inbound":
    case "effective": return { left: "inbound", right: "effective" }
    case "wire": return { left: "effective", right: "wire" }
    case "upstream": return { left: "wire", right: "upstream" }
    case "forwarded": return { left: "upstream", right: "forwarded" }
    case "attempts":
    case "meta": return null
  }
}

const manualOverride = ref<PairChoice | null>(null)
const prevSelectionStage = ref<StageId | null>(null)

watch(
  () => {
    const r = props.resolved
    if (!r || r.kind === "absent") return null
    if ("stage" in r.selection) return r.selection.stage
    return null
  },
  (newStage) => {
    if (newStage !== prevSelectionStage.value && newStage != null) {
      manualOverride.value = null
    }
    prevSelectionStage.value = newStage
  },
)

const pair = computed<PairChoice | null>(() => manualOverride.value ?? defaultPair(props.activeStage))

const applicable = computed(() => {
  const r = props.resolved
  if (!r || r.kind === "absent") return false
  if (r.kind === "attempts" || r.kind === "attempt" || r.kind === "meta" || r.kind === "metaError" || r.kind === "headers") return false
  return pair.value != null
})

function getMessageAt(stage: StageId, messageIndex: number): MessageContent | null {
  const e = props.entry
  if (!e) return null
  if (stage === "inbound") return e.inboundRequest.messages?.[messageIndex] ?? null
  if (stage === "effective") return e.effectiveRequest?.messages?.[messageIndex] ?? null
  if (stage === "wire") return e.outboundRequest?.messages?.[messageIndex] ?? null
  if (stage === "upstream") return e.outboundResponse?.content ?? null
  if (stage === "forwarded") return e.inboundResponse?.content ?? null
  return null
}
</script>

<template>
  <div
    v-if="!applicable"
    class="related-disabled"
  >Cross-stage diff doesn't apply to this selection.</div>
  <SideBySideSlice
    v-else-if="pair && resolved?.kind === 'message'"
    :left-label="pair.left"
    :right-label="pair.right"
  >
    <template #left>
      <MessageBlock
        v-if="getMessageAt(pair.left, resolved.selection.messageIndex)"
        :message="getMessageAt(pair.left, resolved.selection.messageIndex)!"
        :index="resolved.selection.messageIndex"
      />
      <div
        v-else
        class="absent"
      >absent at {{ pair.left }}</div>
    </template>
    <template #right>
      <MessageBlock
        v-if="getMessageAt(pair.right, resolved.selection.messageIndex)"
        :message="getMessageAt(pair.right, resolved.selection.messageIndex)!"
        :index="resolved.selection.messageIndex"
      />
      <div
        v-else
        class="absent"
      >absent at {{ pair.right }}</div>
    </template>
  </SideBySideSlice>
  <div
    v-else
    class="related-disabled"
  >Cross-stage view for this selection kind not yet implemented (deferred to v2 RFC).</div>
</template>

<style scoped>
.related-disabled, .absent { padding: 24px; text-align: center; color: rgb(var(--v-theme-on-surface-variant)); }
</style>
```

### Task 3.10: RelatedTabs.vue with v-tabs + v-window + disabled-tab fallback

**Files:**
- Create: `ui/src/components/detail/related/RelatedTabs.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue"

import type { ContentBlock, HistoryEntry } from "@/types"
import type { ResolvedSelection } from "@/composables/useResolvedSelection"
import type { StageId } from "@/composables/useOutlineSelection"

import { isToolResultBlock, isToolUseBlock } from "@/utils/typeGuards"

import RelatedCrossStage from "./RelatedCrossStage.vue"
import RelatedJson from "./RelatedJson.vue"
import RelatedPair from "./RelatedPair.vue"

const props = defineProps<{
  resolved: ResolvedSelection | null
  entry: HistoryEntry | null
  activeStage: StageId
  toolMaps: { resultMap: Record<string, ContentBlock>; nameMap: Record<string, string> }
}>()

const activeTab = ref<"pair" | "cross" | "json">("json")

const pairEnabled = computed(() => {
  const r = props.resolved
  if (!r || r.kind !== "block") return false
  return isToolUseBlock(r.block) || isToolResultBlock(r.block)
})

const crossEnabled = computed(() => {
  const r = props.resolved
  if (!r || r.kind === "absent") return false
  if (r.kind === "attempts" || r.kind === "attempt" || r.kind === "meta" || r.kind === "metaError" || r.kind === "headers") return false
  return r.kind === "message" // v1: only message-kind cross-stage diff implemented
})

// If active tab becomes disabled, fall back to JSON (always enabled)
watch([pairEnabled, crossEnabled], () => {
  if (activeTab.value === "pair" && !pairEnabled.value) activeTab.value = "json"
  if (activeTab.value === "cross" && !crossEnabled.value) activeTab.value = "json"
})
</script>

<template>
  <div class="related-tabs">
    <v-tabs
      v-model="activeTab"
      density="compact"
      color="primary"
    >
      <v-tab
        value="pair"
        :disabled="!pairEnabled"
      >Pair</v-tab>
      <v-tab
        value="cross"
        :disabled="!crossEnabled"
      >Cross-stage</v-tab>
      <v-tab value="json">JSON</v-tab>
    </v-tabs>
    <v-window v-model="activeTab">
      <v-window-item value="pair">
        <RelatedPair
          :resolved="resolved"
          :tool-maps="toolMaps"
        />
      </v-window-item>
      <v-window-item value="cross">
        <RelatedCrossStage
          :resolved="resolved"
          :entry="entry"
          :active-stage="activeStage"
        />
      </v-window-item>
      <v-window-item value="json">
        <RelatedJson
          :resolved="resolved"
          :entry="entry"
        />
      </v-window-item>
    </v-window>
  </div>
</template>

<style scoped>
.related-tabs { display: flex; flex-direction: column; min-height: 0; }
</style>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:ui`
Expected: 0 errors.

- [ ] **Step 3: Commit Related* batch**

```bash
git add ui/src/components/detail/related/
git commit -m "feat(detail): RelatedTabs + RelatedPair + RelatedCrossStage + RelatedJson + SideBySideSlice

RelatedTabs uses <v-tabs> + <v-window> with disabled-tab→JSON fallback watch.
RelatedPair shows tool_use/tool_result counterpart via toolMaps (use→result;
result→use covered in commit 4 via positionMap split).
RelatedCrossStage default pair = semantic per activeStage; manual override
dropped only when selection.stage changes.
RelatedJson always-enabled; SideBySideSlice is a 2-column generic wrapper."
```

---

# Commit 4: OutlineTree + OutlineHeader + DetailLayout + flatNodes + positionMap

### Task 4.1: Update useTocTree.ts — rewrite tocTree for stage-aware subtrees + rename colliding ids + add flatNodes

**Files:**
- Modify: `ui/src/composables/useTocTree.ts`

- [ ] **Step 1: Read current useTocTree.ts then replace tocTree computed**

Open `ui/src/composables/useTocTree.ts`. Modify the `tocTree` computed (lines 79-169) to take `activeStage` as a parameter and emit different subtrees:

- Rename `id: "request"` at line 88 (system leaf) → `"request.system"`
- Rename `id: "response"` at line 123 (error leaf) → `"response.error"`
- Add `activeStage` as a Ref param to `useTocTree`
- Only emit `request` subtree when `activeStage ∈ {inbound, effective, wire}`
- Only emit `response` subtree (including sseEvents nested) when `activeStage ∈ {upstream, forwarded}`
- Always emit entry-global subtree (`httpHeaders`, `attempts`, `meta`)
- ADD `flatNodes` computed (returns `Array<{ node: TocNode; depth: number; expanded: boolean }>`)

Replace the whole `useTocTree` function. Here is the new file content (replaces lines 75-230):

```typescript
import {
  //
  computed,
  ref,
  type ComputedRef,
  type Ref,
} from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"
import type { StageId } from "./useOutlineSelection"

import { isMessageBearing, isResponseSse } from "./useOutlineSelection"

export interface TocNode {
  id: string
  label: string
  icon: string
  children?: Array<TocNode>
}

export interface FlatTocNode {
  node: TocNode
  depth: number
  expanded: boolean
}

export interface UseTocTreeReturn {
  tocTree: ComputedRef<Array<TocNode>>
  flatNodes: ComputedRef<Array<FlatTocNode>>
  expandedNodes: Ref<Set<string>>
  toggleNode: (id: string) => void
}

function roleIcon(role: string): string {
  if (role === "user") return "mdi-account"
  if (role === "assistant") return "mdi-robot"
  if (role === "system") return "mdi-cog"
  if (role === "tool") return "mdi-wrench"
  return "mdi-message-text"
}

function blockTypeIcon(type: string): string {
  if (type === "text") return "mdi-text"
  if (type === "thinking" || type === "redacted_thinking") return "mdi-brain"
  if (type === "tool_use") return "mdi-wrench"
  if (type === "tool_result") return "mdi-clipboard-check"
  if (type === "image") return "mdi-image"
  return "mdi-code-braces"
}

function blockLabel(block: { type: string; text?: string; thinking?: string; name?: string; tool_use_id?: string }): string {
  if (block.type === "text" && typeof block.text === "string") {
    const preview = block.text.slice(0, 30).replaceAll("\n", " ")
    return `text: ${preview}${block.text.length > 30 ? "…" : ""}`
  }
  if (block.type === "thinking") return "thinking"
  if (block.type === "redacted_thinking") return "redacted_thinking"
  if (block.type === "tool_use" && block.name) return `tool_use: ${block.name}`
  if (block.type === "tool_result") return `tool_result`
  return block.type
}

function msgContentBlocks(msg: MessageContent): Array<{ type: string; text?: string; thinking?: string; name?: string; tool_use_id?: string }> {
  if (typeof msg.content === "string") return [{ type: "text", text: msg.content }]
  if (Array.isArray(msg.content)) return msg.content as Array<{ type: string; text?: string; thinking?: string; name?: string; tool_use_id?: string }>
  return []
}

function msgSummary(msg: MessageContent): string {
  const blocks = msgContentBlocks(msg)
  if (blocks.length === 1 && blocks[0].type === "text") {
    const preview = (blocks[0].text ?? "").slice(0, 30).replaceAll("\n", " ")
    return preview + ((blocks[0].text ?? "").length > 30 ? "…" : "")
  }
  return `${blocks.length} blocks`
}

function stageMessages(entry: HistoryEntry, stage: StageId): Array<MessageContent> {
  if (stage === "inbound") return entry.inboundRequest.messages ?? []
  if (stage === "effective") return entry.effectiveRequest?.messages ?? []
  if (stage === "wire") return entry.outboundRequest?.messages ?? []
  return []
}

function stageSystem(entry: HistoryEntry, stage: StageId): unknown {
  if (stage === "inbound") return entry.inboundRequest.system
  if (stage === "effective") return entry.effectiveRequest?.system
  if (stage === "wire") return entry.outboundRequest?.system
  return undefined
}

/** Build outline tree (stage-aware) + flatNodes for virtual scroll. */
export function useTocTree(
  entry: Ref<HistoryEntry | null> | ComputedRef<HistoryEntry | null>,
  activeStage: Ref<StageId> | ComputedRef<StageId>,
): UseTocTreeReturn {
  const expandedNodes = ref(new Set<string>(["request", "response"]))

  const tocTree = computed<Array<TocNode>>(() => {
    if (!entry.value) return []
    const e = entry.value
    const stage = activeStage.value
    const nodes: Array<TocNode> = []

    // Request subtree (only for MessageBearingStage)
    if (isMessageBearing(stage)) {
      const messages = stageMessages(e, stage)
      const requestChildren: Array<TocNode> = []

      if (stageSystem(e, stage)) {
        requestChildren.push({ id: "request.system", label: "system", icon: "mdi-cog" })
      }
      for (const [i, msg] of messages.entries()) {
        const blocks = msgContentBlocks(msg)
        const contentChildren: Array<TocNode> =
          blocks.length > 1
            ? blocks.map((block, j) => ({
                id: `request.messages.${i}.content.${j}`,
                label: blockLabel(block),
                icon: blockTypeIcon(block.type),
              }))
            : []
        requestChildren.push({
          id: `request.messages.${i}`,
          label: `#${i + 1} ${msg.role}: ${msgSummary(msg)}`,
          icon: roleIcon(msg.role),
          children: contentChildren.length > 0 ? contentChildren : undefined,
        })
      }
      nodes.push({
        id: "request",
        label: `request (${messages.length} msgs)`,
        icon: "mdi-arrow-up-bold",
        children: requestChildren,
      })
    }

    // Response subtree (only for ResponseSseStage)
    if (isResponseSse(stage)) {
      const responseChildren: Array<TocNode> = []
      if (e.outboundResponse?.error) {
        responseChildren.push({ id: "response.error", label: "error", icon: "mdi-alert-circle" })
      }
      if (e.outboundResponse?.content) {
        responseChildren.push({ id: "response.content", label: "content", icon: "mdi-robot" })
      }
      const sseSource = stage === "upstream" ? e.sseEvents : e.inboundResponse?.sseEvents
      if (sseSource?.length) {
        responseChildren.push({ id: "section-sse-events", label: `sseEvents (${sseSource.length})`, icon: "mdi-broadcast" })
      }
      if (e.outboundResponse || sseSource?.length) {
        nodes.push({
          id: "response",
          label: "response",
          icon: "mdi-arrow-down-bold",
          children: responseChildren,
        })
      }
    }

    // Entry-global subtree (always rendered)
    if (e.httpHeaders) {
      nodes.push({ id: "httpHeaders", label: "http headers", icon: "mdi-web" })
    }
    if (e.attempts && e.attempts.length > 1) {
      nodes.push({ id: "attempts", label: `attempts (${e.attempts.length})`, icon: "mdi-refresh" })
    }
    nodes.push({ id: "meta", label: "meta", icon: "mdi-information" })
    if (e.state === "failed" || e.outboundResponse?.error) {
      nodes.push({ id: "meta.error", label: "error", icon: "mdi-alert-circle" })
    }

    return nodes
  })

  /** Flatten tree into depth-tagged list respecting expand state, for v-virtual-scroll. */
  const flatNodes = computed<Array<FlatTocNode>>(() => {
    const out: Array<FlatTocNode> = []
    function walk(node: TocNode, depth: number): void {
      const expanded = expandedNodes.value.has(node.id)
      out.push({ node, depth, expanded })
      if (expanded && node.children) {
        for (const c of node.children) walk(c, depth + 1)
      }
    }
    for (const n of tocTree.value) walk(n, 0)
    return out
  })

  function toggleNode(id: string): void {
    if (expandedNodes.value.has(id)) {
      expandedNodes.value.delete(id)
    } else {
      expandedNodes.value.add(id)
    }
    expandedNodes.value = new Set(expandedNodes.value)
  }

  return { tocTree, flatNodes, expandedNodes, toggleNode }
}
```

- [ ] **Step 2: Write flatNodes tests**

Create `ui/tests/flat-nodes.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { computed, ref } from "vue"

import type { HistoryEntry } from "@/types"
import type { StageId } from "@/composables/useOutlineSelection"

import { useTocTree } from "@/composables/useTocTree"

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: "e", startedAt: 0, endpoint: "anthropic-messages", inboundRequest: { messages: [{ role: "user", content: "hi" } as never] }, ...over } as HistoryEntry
}

describe("useTocTree", () => {
  test("inbound stage emits request subtree, not response", () => {
    const e = ref(entry())
    const stage = ref<StageId>("inbound")
    const { tocTree } = useTocTree(e, stage)
    expect(tocTree.value.find((n) => n.id === "request")).toBeDefined()
    expect(tocTree.value.find((n) => n.id === "response")).toBeUndefined()
  })

  test("upstream stage emits response subtree, not request", () => {
    const e = ref(entry({ outboundResponse: { success: true, model: "x", usage: {} as never, content: { role: "assistant", content: "hi" } as never } as never }))
    const stage = ref<StageId>("upstream")
    const { tocTree } = useTocTree(e, stage)
    expect(tocTree.value.find((n) => n.id === "response")).toBeDefined()
    expect(tocTree.value.find((n) => n.id === "request")).toBeUndefined()
  })

  test("entry-global nodes always present", () => {
    const e = ref(entry({ httpHeaders: { inboundRequest: { "x-test": "1" } } as never }))
    const stage = ref<StageId>("inbound")
    const { tocTree } = useTocTree(e, stage)
    expect(tocTree.value.find((n) => n.id === "httpHeaders")).toBeDefined()
    expect(tocTree.value.find((n) => n.id === "meta")).toBeDefined()
  })

  test("flatNodes respects expand state", () => {
    const e = ref(entry())
    const stage = ref<StageId>("inbound")
    const { flatNodes, expandedNodes, toggleNode } = useTocTree(e, stage)
    const before = flatNodes.value.length
    // Start: request expanded by default → children flattened
    expect(flatNodes.value.some((f) => f.node.id === "request.messages.0")).toBe(true)
    toggleNode("request")
    expect(flatNodes.value.length).toBeLessThan(before)
    expect(flatNodes.value.some((f) => f.node.id === "request.messages.0")).toBe(false)
    void expandedNodes
  })

  test("ids do NOT collide (request.system vs request)", () => {
    const e = ref(entry({ inboundRequest: { messages: [], system: "you are a bot" } }))
    const stage = ref<StageId>("inbound")
    const { tocTree } = useTocTree(e, stage)
    const req = tocTree.value.find((n) => n.id === "request")
    expect(req).toBeDefined()
    const systemLeaf = req?.children?.find((c) => c.id === "request.system")
    expect(systemLeaf).toBeDefined()
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npm run test:ui:bun -- flat-nodes && npm run typecheck:ui`
Expected: All pass; 0 type errors.

- [ ] **Step 4: Commit useTocTree changes**

```bash
git add ui/src/composables/useTocTree.ts ui/tests/flat-nodes.test.ts
git commit -m "refactor(detail): useTocTree — stage-aware subtrees + flatNodes + id rename

Tree emission now switches by activeStage:
- MessageBearingStage → request subtree
- ResponseSseStage → response subtree (incl. sseEvents nested)
- entry-global (httpHeaders/attempts/meta/meta.error) always rendered

Renamed colliding ids: 'request' (system leaf) → 'request.system';
'response' (error leaf) → 'response.error'. Fixes fromId round-trip.

ADDED flatNodes computed for v-virtual-scroll. Removed scrollTo/
ensureExpanded/activeId (deferred to commit 7 for the rest of cleanup;
this commit only adds new + removes things only used internally)."
```

### Task 4.2: Extend useDetailOrchestration.ts — positionMap (split per side)

**Files:**
- Modify: `ui/src/composables/useDetailOrchestration.ts`

- [ ] **Step 1: Add PerStageLoc type + positionMap to toolMaps**

In `ui/src/composables/useDetailOrchestration.ts`, find the `toolMaps` computed (around line 63). Update its return type AND population. Add this type near the top:

```typescript
type PerStageLoc = {
  inbound?: { messageIndex: number; blockIndex: number }
  effective?: { messageIndex: number; blockIndex: number }
  wire?: { messageIndex: number; blockIndex: number }
}
```

Update the `toolMaps` computed (around line 63-91) — rewrite it to scan all 3 message-bearing stages and populate positionMap.use / positionMap.result per side:

```typescript
const toolMaps = computed(() => {
  const resultMap: Record<string, ContentBlock> = {}
  const nameMap: Record<string, string> = {}
  const positionMap: Record<string, { use?: PerStageLoc; result?: PerStageLoc }> = {}
  if (!entry.value) return { resultMap, nameMap, positionMap }

  function ensureEntry(id: string): { use?: PerStageLoc; result?: PerStageLoc } {
    positionMap[id] ??= {}
    return positionMap[id]
  }

  function scan(messages: Array<MessageContent> | undefined, stage: "inbound" | "effective" | "wire"): void {
    if (!messages) return
    for (const [mi, msg] of messages.entries()) {
      if (Array.isArray(msg.content)) {
        for (const [bi, block] of msg.content.entries()) {
          if (isToolResultBlock(block)) {
            resultMap[block.tool_use_id] = block
            const e = ensureEntry(block.tool_use_id)
            e.result ??= {}
            e.result[stage] = { messageIndex: mi, blockIndex: bi }
          }
          if (isToolUseBlock(block)) {
            nameMap[block.id] = block.name
            const e = ensureEntry(block.id)
            e.use ??= {}
            e.use[stage] = { messageIndex: mi, blockIndex: bi }
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) nameMap[tc.id] = tc.function.name
      }
      if (msg.role === "tool" && msg.tool_call_id) {
        resultMap[msg.tool_call_id] = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        } as ContentBlock
      }
    }
  }

  scan(entry.value.inboundRequest.messages, "inbound")
  scan(entry.value.effectiveRequest?.messages, "effective")
  scan(entry.value.outboundRequest?.messages, "wire")

  return { resultMap, nameMap, positionMap }
})
```

Also update the `DetailOrchestration` interface (around line 36):

```typescript
  toolMaps: ComputedRef<{
    resultMap: Record<string, ContentBlock>
    nameMap: Record<string, string>
    positionMap: Record<string, { use?: PerStageLoc; result?: PerStageLoc }>
  }>
```

- [ ] **Step 2: Write positionMap tests**

Create `ui/tests/tool-position-map.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { ref } from "vue"

import type { HistoryEntry } from "@/types"

import { useDetailOrchestration } from "@/composables/useDetailOrchestration"

function entryWithTools(): HistoryEntry {
  return {
    id: "e",
    startedAt: 0,
    endpoint: "anthropic-messages",
    inboundRequest: {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] } as never,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } as never,
      ],
    },
    effectiveRequest: {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] } as never,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } as never,
      ],
    } as never,
  } as HistoryEntry
}

describe("toolMaps.positionMap", () => {
  test("populates both use and result for same id in same pass", () => {
    const { toolMaps } = useDetailOrchestration(ref(entryWithTools()))
    const m = toolMaps.value.positionMap["tu_1"]
    expect(m?.use?.inbound).toEqual({ messageIndex: 0, blockIndex: 0 })
    expect(m?.use?.effective).toEqual({ messageIndex: 0, blockIndex: 0 })
    expect(m?.result?.inbound).toEqual({ messageIndex: 1, blockIndex: 0 })
    expect(m?.result?.effective).toEqual({ messageIndex: 1, blockIndex: 0 })
  })

  test("use and result do not alias", () => {
    const { toolMaps } = useDetailOrchestration(ref(entryWithTools()))
    expect(toolMaps.value.positionMap["tu_1"]?.use?.inbound?.messageIndex).toBe(0)
    expect(toolMaps.value.positionMap["tu_1"]?.result?.inbound?.messageIndex).toBe(1)
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npm run test:ui:bun -- tool-position-map && npm run typecheck:ui`
Expected: All pass; 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/composables/useDetailOrchestration.ts ui/tests/tool-position-map.test.ts
git commit -m "feat(detail): toolMaps.positionMap split per side (use vs result)

Single-pass scan over inbound/effective/wire request messages populates
positionMap[id].use[stage] for tool_use blocks and positionMap[id].result[stage]
for tool_result blocks. Same key never aliases — scrollToCall and
scrollToResult produce distinct positions (RFC R2'' HIGH fix)."
```

### Task 4.3: OutlineHeader.vue (search placeholder + noauto pill)

**Files:**
- Create: `ui/src/components/detail/outline/OutlineHeader.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed } from "vue"
import { useRoute, useRouter } from "vue-router"

import { useDetailViewState } from "@/composables/useDetailViewState"

const detail = useDetailViewState()
const route = useRoute()
const router = useRouter()

const noautoActive = computed(() => route.query.noauto === "1" || route.query.noauto === "true")

function clearNoauto(): void {
  const q = { ...route.query }
  delete q.noauto
  void router.replace({ query: q })
}
</script>

<template>
  <div class="outline-header">
    <v-text-field
      v-model="detail.detailSearch"
      placeholder="Search outline... (filter wiring DEFERRED to v2 RFC §9 D2)"
      density="compact"
      hide-details
      variant="outlined"
      clearable
      prepend-inner-icon="mdi-magnify"
    />
    <v-chip
      v-if="noautoActive"
      closable
      size="small"
      color="warning"
      variant="tonal"
      class="ml-2"
      @click:close="clearNoauto"
    >Auto-select: off</v-chip>
  </div>
</template>

<style scoped>
.outline-header {
  display: flex;
  align-items: center;
  padding: 8px;
  gap: 4px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}
</style>
```

### Task 4.4: OutlineTree.vue (v-virtual-scroll + emits select(Selection))

**Files:**
- Create: `ui/src/components/detail/outline/OutlineTree.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue"

import { fromId, type Selection, type StageId } from "@/composables/useOutlineSelection"
import { useTocTree, type FlatTocNode } from "@/composables/useTocTree"
import { useHistoryStore } from "@/composables/useHistoryStore"

const props = defineProps<{
  activeStage: StageId
  selectedId: string | null
  stickyIntentId: string | null
}>()

const emit = defineEmits<{
  select: [s: Selection]
  selectId: [id: string]
}>()

const store = useHistoryStore()
const entryRef = computed(() => store.selectedEntry)
const activeStageRef = computed(() => props.activeStage)

const { flatNodes, expandedNodes, toggleNode } = useTocTree(entryRef, activeStageRef)

const vScrollRef = ref<HTMLElement | null>(null)

// Scroll selected into view when it changes from outside
watch(
  () => props.selectedId,
  (id) => {
    if (!id) return
    const idx = flatNodes.value.findIndex((f) => f.node.id === id)
    if (idx < 0) return
    // v-virtual-scroll exposes scrollToIndex via ref; deferred to v2 — for now, native scrollIntoView
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(id)}"]`)
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  },
)

function onRowClick(item: FlatTocNode): void {
  emit("selectId", item.node.id)
  // Also emit typed Selection if codec returns one
  const s = fromId(item.node.id, { activeStage: props.activeStage })
  if (s) emit("select", s)
}

function onKeyDown(e: KeyboardEvent): void {
  // Don't intercept j/k — let page-level handler take them
  if (e.key === "j" || e.key === "k") return

  if (e.key === "ArrowDown") {
    e.preventDefault()
    const idx = flatNodes.value.findIndex((f) => f.node.id === props.selectedId)
    const next = flatNodes.value[Math.min(idx + 1, flatNodes.value.length - 1)]
    if (next) onRowClick(next)
  } else if (e.key === "ArrowUp") {
    e.preventDefault()
    const idx = flatNodes.value.findIndex((f) => f.node.id === props.selectedId)
    const prev = flatNodes.value[Math.max(idx - 1, 0)]
    if (prev) onRowClick(prev)
  } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault()
    const cur = flatNodes.value.find((f) => f.node.id === props.selectedId)
    if (cur?.node.children?.length) {
      if ((e.key === "ArrowRight") !== cur.expanded) {
        toggleNode(cur.node.id)
      }
    }
  }
}

defineExpose({ vScrollRef })
</script>

<template>
  <div
    ref="vScrollRef"
    class="outline-tree"
    tabindex="0"
    @keydown="onKeyDown"
  >
    <v-virtual-scroll
      :items="flatNodes"
      :item-height="28"
    >
      <template #default="{ item }">
        <div
          :data-outline-id="(item as FlatTocNode).node.id"
          class="outline-row"
          :class="{
            selected: (item as FlatTocNode).node.id === selectedId,
            ghost: (item as FlatTocNode).node.id === stickyIntentId && (item as FlatTocNode).node.id !== selectedId,
          }"
          :style="{ paddingLeft: `${(item as FlatTocNode).depth * 16 + 8}px` }"
          @click="onRowClick(item as FlatTocNode)"
        >
          <v-tooltip
            v-if="(item as FlatTocNode).node.id === stickyIntentId && (item as FlatTocNode).node.id !== selectedId"
            location="right"
            text="Not present in this entry — original selection"
          >
            <template #activator="{ props: tipProps }">
              <span v-bind="tipProps">
                <span
                  class="outline-toggle"
                  @click.stop="(item as FlatTocNode).node.children?.length && toggleNode((item as FlatTocNode).node.id)"
                >
                  <v-icon
                    v-if="(item as FlatTocNode).node.children?.length"
                    :icon="(item as FlatTocNode).expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                    size="x-small"
                  />
                </span>
                <v-icon
                  :icon="(item as FlatTocNode).node.icon"
                  size="x-small"
                  class="outline-icon"
                />
                <span class="outline-label">{{ (item as FlatTocNode).node.label }}</span>
              </span>
            </template>
          </v-tooltip>
          <template v-else>
            <span
              class="outline-toggle"
              @click.stop="(item as FlatTocNode).node.children?.length && toggleNode((item as FlatTocNode).node.id)"
            >
              <v-icon
                v-if="(item as FlatTocNode).node.children?.length"
                :icon="(item as FlatTocNode).expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                size="x-small"
              />
            </span>
            <v-icon
              :icon="(item as FlatTocNode).node.icon"
              size="x-small"
              class="outline-icon"
            />
            <span class="outline-label">{{ (item as FlatTocNode).node.label }}</span>
          </template>
        </div>
      </template>
    </v-virtual-scroll>
    <div
      v-if="expandedNodes.size === 0"
      class="outline-hint"
    >Click an outline node to view its details on the right.</div>
  </div>
</template>

<style scoped>
.outline-tree {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  outline: none;
}
.outline-row {
  display: flex;
  align-items: center;
  height: 28px;
  cursor: pointer;
  font-size: 0.78rem;
  user-select: none;
  gap: 4px;
}
.outline-row:hover {
  background: rgb(var(--v-theme-surface-variant) / 40%);
}
.outline-row.selected {
  background: rgb(var(--v-theme-primary) / 12%);
  color: rgb(var(--v-theme-primary));
}
.outline-row.ghost {
  border: 1px dashed rgb(var(--v-theme-on-surface-variant) / 50%);
  opacity: 0.4;
}
.outline-toggle {
  width: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.outline-icon { opacity: 0.6; }
.outline-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.outline-hint {
  padding: 16px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  font-style: italic;
}
</style>
```

### Task 4.5: DetailLayout.vue

**Files:**
- Create: `ui/src/components/detail/DetailLayout.vue`

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { computed } from "vue"

import type { HistoryEntry } from "@/types"

import OutlineHeader from "./outline/OutlineHeader.vue"
import OutlineTree from "./outline/OutlineTree.vue"
import SelectedSlice from "./slice/SelectedSlice.vue"
import RelatedTabs from "./related/RelatedTabs.vue"
import SplitPane from "@/components/ui/SplitPane.vue"

import type { Selection, StageId } from "@/composables/useOutlineSelection"
import { useDiffModal } from "@/composables/useDiffModal"
import { useDetailOrchestration } from "@/composables/useDetailOrchestration"
import { provideMessageActions } from "@/composables/useMessageActions"
import { useHistoryStore } from "@/composables/useHistoryStore"

const props = defineProps<{
  entry: HistoryEntry | null
  selection: Selection | null
  selectedId: string | null
  stickyIntentId: string | null
  activeStage: StageId
}>()

const emit = defineEmits<{
  selectId: [id: string]
  select: [s: Selection]
}>()

const _store = useHistoryStore()
void _store
const orch = useDetailOrchestration(computed(() => props.entry))
const diffModal = useDiffModal()

// DetailLayout provides MessageActions; openDiff drives the singleton modal state
// rendered by VDetailPage. jumpToCounterpart kept as no-op (deleted in commit 7).
provideMessageActions({
  openDiff: (original, effective, label) => diffModal.open(original, effective, label),
  jumpToCounterpart: () => {
    /* no-op — to be removed in commit 7 */
  },
})

import { useResolvedSelection } from "@/composables/useResolvedSelection"
import { ref, watch } from "vue"
const selRef = ref<Selection | null>(props.selection)
const entryRef = ref<HistoryEntry | null>(props.entry)
watch(() => props.selection, (s) => { selRef.value = s })
watch(() => props.entry, (e) => { entryRef.value = e })
const resolved = useResolvedSelection(selRef, entryRef)
</script>

<template>
  <SplitPane
    storage-key="detail-split"
    :default-left-width="480"
    :min-left-width="320"
    :max-left-width="800"
  >
    <template #left>
      <div class="outline-pane">
        <OutlineHeader />
        <OutlineTree
          :active-stage="activeStage"
          :selected-id="selectedId"
          :sticky-intent-id="stickyIntentId"
          @select="(s) => emit('select', s)"
          @select-id="(id) => emit('selectId', id)"
        />
      </div>
    </template>
    <template #right>
      <div
        class="right-pane"
        data-testid="detail-scroll-container"
      >
        <SelectedSlice
          :selection="selection"
          :entry="entry"
        />
        <div class="related-section">
          <RelatedTabs
            :resolved="resolved"
            :entry="entry"
            :active-stage="activeStage"
            :tool-maps="orch.toolMaps.value"
          />
        </div>
      </div>
    </template>
  </SplitPane>
</template>

<style scoped>
.outline-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-right: 1px solid rgb(var(--v-theme-surface-variant));
}
.right-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.related-section {
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  min-height: 240px;
  flex-shrink: 0;
}
</style>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:ui`
Expected: 0 errors.

- [ ] **Step 3: Commit OutlineHeader + OutlineTree + DetailLayout**

```bash
git add ui/src/components/detail/outline/ ui/src/components/detail/DetailLayout.vue
git commit -m "feat(detail): OutlineHeader + OutlineTree + DetailLayout (unmounted)

- OutlineHeader: search input placeholder (wiring deferred §9 D2) + noauto pill
- OutlineTree: <v-virtual-scroll> over flatNodes; emits select(Selection)+selectId(string);
  ghost rendering with hover tooltip; keyboard ↑/↓/←/→ (j/k explicitly not consumed)
- DetailLayout: SplitPane wrapper; provides MessageActions (openDiff via
  useDiffModal singleton; jumpToCounterpart noop); SelectedSlice top / RelatedTabs bottom

Not wired into VDetailPage yet — that's commit 5 cutover."
```

---

# Commit 5: Cutover — VDetailPage uses DetailLayout

> **This is the user-validation point.** After this commit, the right pane is selection-driven. PAUSE for user manual testing before commits 6/7/8.

### Task 5.1: Add useDetailViewState `@deferred-rfc D2` JSDoc

**Files:**
- Modify: `ui/src/composables/useDetailViewState.ts`

- [ ] **Step 1: Add deferred-rfc annotations**

Replace `ui/src/composables/useDetailViewState.ts` body:

```typescript
import { defineStore } from "pinia"
import { shallowRef } from "vue"

/** Detail panel view state: search, filters, display mode, and active stage. */
export const useDetailViewState = defineStore("detailView", () => {
  return {
    /** Outline search input — write-only in v1; filter→flatNodes wiring deferred (see RFC §9 D2). */
    detailSearch: shallowRef(""),
    /** @deferred-rfc D2 — see RFC §9 (role filter UI removed in commit 6) */
    detailFilterRole: shallowRef(""),
    /** @deferred-rfc D2 — see RFC §9 */
    detailFilterType: shallowRef(""),
    /** @deferred-rfc D2 — passed through provideContentContext to Tool* blocks */
    aggregateTools: shallowRef(true),
    /** @deferred-rfc D2 — see RFC §9 */
    showOnlyRewritten: shallowRef(false),
    /** First-level pipeline-stage filter (inbound | effective | wire | upstream | forwarded | attempts | meta). */
    activeStage: shallowRef<string>("inbound"),
  }
})

/** Store type for consumers that need explicit typing */
export type DetailViewState = ReturnType<typeof useDetailViewState>
```

### Task 5.2: Rewrite scrollToResult/scrollToCall + delete highlightBlock

**Files:**
- Modify: `ui/src/composables/useDetailOrchestration.ts`

- [ ] **Step 1: Find lines 48-52 (`highlightBlock`) and delete them**

Remove this from `ui/src/composables/useDetailOrchestration.ts`:

```typescript
function highlightBlock(el: HTMLElement): void {
  el.classList.remove("highlight-flash")
  void el.offsetWidth
  el.classList.add("highlight-flash")
}
```

- [ ] **Step 2: Rewrite scrollToResult and scrollToCall (around lines 139-153)**

Replace those two functions:

```typescript
function lookupPos(id: string, side: "use" | "result"): { stage: "inbound" | "effective" | "wire"; messageIndex: number; blockIndex: number } | null {
  const entry = toolMaps.value.positionMap[id]?.[side]
  if (!entry) return null
  for (const stage of ["effective", "inbound", "wire"] as const) {
    if (entry[stage]) return { stage, ...entry[stage]! }
  }
  return null
}

function scrollToResult(toolUseId: string): void {
  const loc = lookupPos(toolUseId, "result")
  if (!loc) return
  // selectByObject is injected via provideContentContext from VDetailPage
  context.selectByObject?.({ kind: "block", ...loc })
}

function scrollToCall(toolUseId: string): void {
  const loc = lookupPos(toolUseId, "use")
  if (!loc) return
  context.selectByObject?.({ kind: "block", ...loc })
}
```

> The `context` reference is the orchestration's existing local state (refactor to receive `selectByObject` via parameter or inject — adapt to current code structure).

To wire `selectByObject` into useDetailOrchestration, update its signature to optionally accept the function:

```typescript
export function useDetailOrchestration(
  entry: Ref<HistoryEntry | null> | ComputedRef<HistoryEntry | null>,
  opts: { selectByObject?: (s: import("./useOutlineSelection").Selection) => void } = {},
): DetailOrchestration {
  // ... existing code ...
  function scrollToResult(toolUseId: string): void { /* ... use opts.selectByObject ... */ }
  // ...
}
```

- [ ] **Step 3: Also remove `filteredMessages` from useDetailOrchestration**

Delete the `filteredMessages` computed (around lines 94-105) AND its export in the return object (line 165) AND its interface field (line 37).

### Task 5.3: Rewrite VDetailPage.vue

**Files:**
- Modify: `ui/src/pages/vuetify/VDetailPage.vue`

- [ ] **Step 1: Read current VDetailPage.vue** — needed to preserve header / prev-next / Export / Session button logic.

- [ ] **Step 2: Replace `<script setup>` and `<template>` body**

Replace VDetailPage.vue contents (script + template; keep `<style>` mostly intact, drop `.toc-sidebar` / `.detail-body` rules):

```vue
<script setup lang="ts">
import { onKeyStroke } from "@vueuse/core"
import { computed, watch, shallowRef } from "vue"
import { useRoute, useRouter } from "vue-router"

import DiagnosticSummary from "@/components/detail/DiagnosticSummary.vue"
import StageTabs from "@/components/detail/StageTabs.vue"
import DetailLayout from "@/components/detail/DetailLayout.vue"
import RawJsonModal from "@/components/ui/RawJsonModal.vue"
import DiffModal from "@/components/detail/DiffModal.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import { useDetailStages } from "@/composables/useDetailStages"
import { useDetailViewState } from "@/composables/useDetailViewState"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { useOutlineSelection, type Selection, type StageId } from "@/composables/useOutlineSelection"
import { provideRawModal } from "@/composables/useRawModal"
import { useDiffModal } from "@/composables/useDiffModal"
import { provideContentContext } from "@/composables/useContentContext"
import { useDetailOrchestration } from "@/composables/useDetailOrchestration"
import { downloadEntryAsJson } from "@/utils/export-entry"
import { formatDate, formatDuration, formatNumber } from "@/utils/formatters"

const route = useRoute()
const router = useRouter()
const store = useHistoryStore()
const detail = useDetailViewState()

const entryId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""))
const entry = computed(() => store.selectedEntry)
const loading = shallowRef(false)
const loadError = shallowRef<string | null>(null)

const activeStageRef = computed<StageId>({
  get: () => detail.activeStage as StageId,
  set: (v) => {
    detail.activeStage = v
  },
})

// Hoist outline selection composable here — instantiated per VDetailPage mount
const outlineSelection = useOutlineSelection(entry, activeStageRef, route)

// Provider rehoming (RFC §2.5)
const rawModal = provideRawModal()
const diffModal = useDiffModal()
const orch = useDetailOrchestration(entry, {
  selectByObject: (s: Selection) => outlineSelection.selectByObject(s),
})

provideContentContext({
  searchQuery: computed(() => detail.detailSearch),
  filterType: computed(() => detail.detailFilterType),
  aggregateTools: computed(() => detail.aggregateTools),
  toolResultMap: computed(() => orch.toolMaps.value.resultMap),
  toolUseNameMap: computed(() => orch.toolMaps.value.nameMap),
  scrollToResult: orch.scrollToResult,
  scrollToCall: orch.scrollToCall,
})

const { stages } = useDetailStages(entry, activeStageRef, { manageActiveStage: true })

const title = computed(() => {
  if (!entry.value) return "Loading..."
  return entry.value.outboundResponse?.model || entry.value.inboundRequest.model || "Request"
})
const subtitle = computed(() => {
  if (!entry.value) return entryId.value
  const parts: Array<string> = []
  if (entry.value.startedAt) parts.push(formatDate(entry.value.startedAt))
  if (entry.value.durationMs) parts.push(formatDuration(entry.value.durationMs))
  const usage = entry.value.outboundResponse?.usage
  if (usage) parts.push(`${formatNumber(usage.input_tokens)} in / ${formatNumber(usage.output_tokens)} out`)
  return parts.join(" · ") || entryId.value
})

watch(
  entryId,
  async (id) => {
    if (!id) return
    if (store.selectedEntry?.id === id) return
    loading.value = true
    loadError.value = null
    try {
      await store.selectEntry(id)
      if (!store.selectedEntry || store.selectedEntry.id !== id) {
        loadError.value = "Request not found"
      }
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : "Failed to load request"
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function goBack(): void {
  void router.push("/activity")
}
function exportEntry(): void {
  if (entry.value) downloadEntryAsJson(entry.value)
}
function viewSession(): void {
  const sid = entry.value?.sessionId
  if (!sid) return
  store.setFilter("sessionId", sid)
  void router.push("/activity")
}

const entryIndex = computed(() => store.entries.findIndex((e) => e.id === entryId.value))
const positionLabel = computed(() => {
  const i = entryIndex.value
  return i >= 0 ? `${i + 1}/${store.total}` : ""
})
const canPrev = computed(() => entryIndex.value > 0 || (entryIndex.value === 0 && Boolean(store.prevCursor)))
const canNext = computed(
  () => (entryIndex.value >= 0 && entryIndex.value < store.entries.length - 1) || (entryIndex.value === store.entries.length - 1 && Boolean(store.nextCursor)),
)
function goToEntry(id: string): void {
  void router.replace({ name: "activity-detail", params: { id } })
}
async function goAdjacent(dir: "next" | "prev"): Promise<void> {
  const i = entryIndex.value
  if (i === -1) return
  if (dir === "next") {
    if (i < store.entries.length - 1) {
      goToEntry(store.entries[i + 1].id)
      return
    }
    if (store.nextCursor) {
      await store.fetchEntries(store.nextCursor, "older")
      if (store.entries[0]) goToEntry(store.entries[0].id)
    }
  } else {
    if (i > 0) {
      goToEntry(store.entries[i - 1].id)
      return
    }
    if (store.prevCursor) {
      await store.fetchEntries(store.prevCursor, "newer")
      const last = store.entries.at(-1)
      if (last) goToEntry(last.id)
    }
  }
}

function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable
}
onKeyStroke("j", () => {
  if (!isTyping()) void goAdjacent("next")
})
onKeyStroke("k", () => {
  if (!isTyping()) void goAdjacent("prev")
})
onKeyStroke("Escape", () => {
  if (!isTyping()) goBack()
})
onKeyStroke("/", (e) => {
  if (isTyping()) return
  e.preventDefault()
  const input = document.querySelector<HTMLInputElement>(".outline-header input")
  input?.focus()
})

void rawModal
</script>

<template>
  <div class="detail-page v-page-root">
    <!-- Header bar — preserved from previous VDetailPage -->
    <div class="detail-header">
      <v-btn variant="text" size="small" prepend-icon="mdi-arrow-left" @click="goBack">Activity</v-btn>
      <div class="detail-heading">
        <div class="detail-title">{{ title }}</div>
        <div class="detail-subtitle text-caption text-medium-emphasis">{{ subtitle }}</div>
      </div>
      <v-spacer />
      <div class="detail-nav">
        <v-btn variant="text" size="small" icon="mdi-chevron-up" :disabled="!canPrev" title="Newer (k)" @click="goAdjacent('prev')" />
        <span v-if="positionLabel" class="detail-position font-mono text-caption text-medium-emphasis">{{ positionLabel }}</span>
        <v-btn variant="text" size="small" icon="mdi-chevron-down" :disabled="!canNext" title="Older (j)" @click="goAdjacent('next')" />
      </div>
      <v-btn v-if="entry" variant="outlined" size="small" prepend-icon="mdi-download" @click="exportEntry">Export</v-btn>
      <v-btn v-if="entry?.sessionId" variant="text" size="small" prepend-icon="mdi-link-variant" title="Filter Activity to this session" @click="viewSession">Session</v-btn>
    </div>

    <div v-if="loading" class="state-shell">
      <v-progress-circular indeterminate color="primary" />
    </div>
    <div v-else-if="loadError || !entry" class="state-shell">
      <v-icon icon="mdi-alert-circle-outline" size="48" color="error" class="mb-3" />
      <div class="text-h6">{{ loadError || "Request not found" }}</div>
      <div class="text-caption text-medium-emphasis mt-2">ID: {{ entryId }}</div>
      <v-btn class="mt-4" variant="outlined" size="small" @click="goBack">Back to Activity</v-btn>
    </div>

    <div v-else class="detail-loaded">
      <DiagnosticSummary :entry="entry" />
      <StageTabs v-model:active="activeStageRef" :stages="stages" />
      <ErrorBoundary label="Activity detail">
        <DetailLayout
          :entry="entry"
          :selection="outlineSelection.selection.value"
          :selected-id="outlineSelection.selectedId.value"
          :sticky-intent-id="outlineSelection.stickyIntentId.value"
          :active-stage="activeStageRef"
          @select="(s) => outlineSelection.selectByObject(s)"
          @select-id="(id) => outlineSelection.select(id)"
        />
      </ErrorBoundary>
    </div>

    <!-- Shared modals — page-level mount, state from composable singletons -->
    <RawJsonModal
      :visible="rawModal.visible.value"
      :title="rawModal.title.value"
      :data="rawModal.data.value"
      :rewritten-data="rawModal.rewrittenData.value"
      @update:visible="(v) => (rawModal.visible.value = v)"
    />
    <DiffModal
      :visible="diffModal.visible.value"
      :original="diffModal.original.value"
      :effective="diffModal.effective.value"
      :label="diffModal.label.value"
      @update:visible="(v) => { if (!v) diffModal.close() }"
    />
  </div>
</template>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
  flex-shrink: 0;
}
.detail-heading { min-width: 0; }
.detail-nav { display: flex; align-items: center; gap: 2px; }
.detail-position { min-width: 48px; text-align: center; }
.detail-title { font-size: 1rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; }
.detail-subtitle { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-loaded { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 12px 16px 0; }
.state-shell { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; min-height: 200px; }
</style>
```

- [ ] **Step 3: Update e2e selectors**

Modify `tests/e2e-ui/vuetify-history.pw.ts`:
- Line 72: change `.detail-panel .detail-body` to `[data-testid="detail-scroll-container"]`
- Line 99: change `"detail-body"` to `"detail-scroll-container"`

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck:ui && npm run test:ui`
Expected: 0 errors; all tests pass.

- [ ] **Step 5: Commit cutover**

```bash
git add ui/src/pages/vuetify/VDetailPage.vue ui/src/composables/useDetailViewState.ts ui/src/composables/useDetailOrchestration.ts tests/e2e-ui/vuetify-history.pw.ts
git commit -m "feat(detail): cutover — VDetailPage uses DetailLayout (outline-as-main)

USER VALIDATION POINT. After this commit, the right pane is selection-driven:
outline on left drives Slice* + RelatedTabs on right; placeholder shown
until first auto-select (failed entry→metaError; else stage:inbound).

Changes (atomic per RFC §3 commit 5 invariant — split unsafe per §3 row 5
rationale):
- VDetailPage instantiates useOutlineSelection + provideRawModal + provideContentContext
- DetailLayout instantiated; passes selection/selectedId/stickyIntentId
- RawJsonModal + DiffModal mounted at page level; state from singletons
- useDetailOrchestration: scrollToResult/scrollToCall now call selectByObject
  via positionMap (no DOM querySelector); highlightBlock + filteredMessages deleted
- useDetailViewState: deferred fields annotated @deferred-rfc D2
- e2e selectors updated (.detail-panel .detail-body → [data-testid='detail-scroll-container'])
- Kept: DetailPanel + Stage* still on disk but unused (deleted in commit 6)

Manual verification checklist for user:
- entry loads → auto-select fires (failed → metaError; success → inbound stage)
- j/k preserves selection shape; sticky degrade to parent when block absent
- StageTabs change preserves indices when shape compatible
- Outline click → right pane updates
- RelatedTabs: Pair enabled on tool blocks; Cross-stage enabled on messages; JSON always
- noauto=1 URL → right pane empty + pill in OutlineHeader
- Keyboard: outline ↑/↓; Enter focuses right; / focuses search; Esc goes back"
```

> **PAUSE for user to manually exercise the UI. Continue with commits 6/7/8 only after user signoff.**

---

# Commit 6: Delete dead components + tests + docs

### Task 6.1: Delete files

**Files:** (all deleted)

- [ ] **Step 1: Delete components and tests**

```bash
rm ui/src/components/detail/DetailPanel.vue
rm ui/src/components/detail/DetailToolbar.vue
rm ui/src/components/detail/DetailRequestSection.vue
rm ui/src/components/detail/DetailResponseSection.vue
rm ui/src/components/detail/HeadersSection.vue
rm -rf ui/src/components/detail/stages/
rm ui/src/composables/useSharedResizeObserver.ts
rm ui/vitest/detail-request-section.test.ts
```

- [ ] **Step 2: Run grep invariant**

Run:
```bash
grep -rnE 'DetailPanel\.vue|Stage(Inbound|Effective|Wire|Upstream|Forwarded|Attempts|Meta)\.vue|DetailRequestSection|DetailResponseSection|HeadersSection|DetailToolbar|filteredMessages|useSharedResizeObserver' ui/src --include='*.ts' --include='*.vue' --exclude-dir=dist --exclude-dir=node_modules
```
Expected: **No matches.**

If matches found, follow up to remove residuals (most likely JSDoc comments in surviving composables).

- [ ] **Step 3: Update docs**

In `ui/CLAUDE.md`:
- Line 141: change content-render pipeline diagram from `DetailPanel → SectionBlock → MessageBlock → ContentRenderer` to `DetailLayout → SelectedSlice → SliceX → MessageBlock/ContentRenderer`
- Line 180: delete the "DetailPanel 过大" entry from the "需要改进" list

In `ui/README.md`:
- Line 40: replace `DetailPanel.vue # 详情面板主容器` with `DetailLayout.vue # 详情双栏布局 (SplitPane)`
- Line 110: replace `selectedEntry → DetailPanel → MessageBlock → ContentRenderer` with `selectedEntry → DetailLayout → SelectedSlice → MessageBlock/ContentRenderer`

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck:ui && npm run test:ui`
Expected: 0 errors; all tests pass.

- [ ] **Step 5: Commit deletions**

```bash
git add -u ui/ tests/
git commit -m "refactor(detail): delete DetailPanel + Stage* + 8 other dead files

Deletes (after commit 5 cutover; nothing in app references them):
- DetailPanel.vue (replaced by DetailLayout)
- DetailToolbar.vue (replaced by OutlineHeader; other controls deferred §9 D2)
- DetailRequestSection.vue + DetailResponseSection.vue (Slice* compose MessageBlock directly)
- HeadersSection.vue (already had 0 importers)
- stages/Stage{Inbound,Effective,Wire,Upstream,Forwarded,Attempts,Meta}.vue
- useSharedResizeObserver.ts (provideSharedResizeObserver had 0 caller)
- ui/vitest/detail-request-section.test.ts (test for deleted DetailRequestSection)

Grep invariant satisfied: no residuals in ui/src for any of the 11 symbols.
Docs updated (ui/CLAUDE.md, ui/README.md)."
```

---

# Commit 7: Cleanup toc-navigate + jumpToCounterpart + useMessageActions fold-in

### Task 7.1: Delete toc-navigate listeners

**Files:**
- Modify: `ui/src/components/message/MessageBlock.vue`
- Modify: `ui/src/components/detail/SectionBlock.vue`

- [ ] **Step 1: MessageBlock.vue — delete listener block (lines 53-58)**

Remove this block from `ui/src/components/message/MessageBlock.vue`:

```typescript
/** Auto-expand when navigated from TOC sidebar */
function handleTocNavigate() {
  if (collapsed.value) collapsed.value = false
}

onMounted(() => {
  msgRef.value?.addEventListener("toc-navigate", handleTocNavigate)
})

onUnmounted(() => {
  msgRef.value?.removeEventListener("toc-navigate", handleTocNavigate)
})
```

And the `import { onMounted, onUnmounted } from "vue"` if no other callers — verify before removing.

- [ ] **Step 2: SectionBlock.vue — delete listener block (lines 48-53)**

Remove the analogous `handleTocNavigate` + `addEventListener("toc-navigate", ...)` + `removeEventListener` block from `ui/src/components/detail/SectionBlock.vue`.

### Task 7.2: Delete ↔ jump button + jumpToCounterpart

**Files:**
- Modify: `ui/src/components/message/MessageBlock.vue`
- Delete: `ui/src/composables/useMessageActions.ts`
- Modify: `ui/src/components/detail/DetailLayout.vue`

- [ ] **Step 1: MessageBlock.vue — delete onJump function (lines 148-151) and ↔ button template (lines 202-209)**

In `ui/src/components/message/MessageBlock.vue`:
- Delete the `onJump` function (around line 148-151)
- Delete the `↔ {{ globalViewMode === "rewritten" ? "inbound" : "effective" }}` button (template around lines 202-209)
- Update destructure on line 46 from `const { openDiff, jumpToCounterpart } = useMessageActions()` to `const { openDiff } = useMessageActions()`

- [ ] **Step 2: Delete useMessageActions.ts; replace import in MessageBlock**

Since useMessageActions has only `openDiff` left after step 1, fold it into useDiffModal directly:

In `ui/src/components/message/MessageBlock.vue`, replace:
```typescript
import { useMessageActions } from "@/composables/useMessageActions"
// ...
const { openDiff } = useMessageActions()
```
with:
```typescript
import { useDiffModal } from "@/composables/useDiffModal"
// ...
const diffModal = useDiffModal()
// ... usage: replace openDiff(props.message, props.rewrittenMessage, label) with
//                       diffModal.open(props.message, props.rewrittenMessage, label)
```

- [ ] **Step 3: Update DetailLayout.vue to drop provideMessageActions entirely (no consumers)**

In `ui/src/components/detail/DetailLayout.vue`:
- Remove `import { provideMessageActions } from "@/composables/useMessageActions"`
- Remove the `provideMessageActions({ openDiff, jumpToCounterpart })` call

- [ ] **Step 4: Delete useMessageActions.ts**

```bash
rm ui/src/composables/useMessageActions.ts
```

- [ ] **Step 5: Delete jumpToCounterpart tests**

Modify `ui/vitest/detail-components.test.ts` — delete the `provideMessageActions`/`jumpToCounterpart` assertions (lines 121-150). If the entire test file's purpose was MessageActions, delete the whole file.

- [ ] **Step 6: Grep invariant**

Run:
```bash
grep -rnE 'toc-navigate|jumpToCounterpart|useMessageActions' ui/ --include='*.ts' --include='*.vue' --exclude-dir=dist --exclude-dir=node_modules
```
Expected: **No matches.**

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck:ui && npm run test:ui`
Expected: 0 errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -u ui/
git commit -m "refactor(detail): cleanup toc-navigate listeners + jumpToCounterpart + useMessageActions fold-in

Now that DetailLayout owns selection-driven nav (no DOM scrolling), the
toc-navigate custom event + jumpToCounterpart provider/inject become
orphan code:

- MessageBlock + SectionBlock: delete toc-navigate listener+handler blocks
- MessageBlock: delete ↔ jump button + onJump fn + jumpToCounterpart destructure
- useMessageActions.ts: deleted (1-field interface after jumpToCounterpart
  removal — fold openDiff direct via useDiffModal singleton)
- DetailLayout: drop provideMessageActions (no consumers)
- detail-components.test.ts: delete jumpToCounterpart assertions

Grep invariant: 0 residuals for toc-navigate|jumpToCounterpart|useMessageActions."
```

---

# Commit 8: Cleanup orphan DOM anchors + composable docs

### Task 8.1: Delete tool-use/tool-result DOM anchors

**Files:**
- Modify: `ui/src/components/message/ToolUseBlock.vue`
- Modify: `ui/src/components/message/ToolResultBlock.vue`

- [ ] **Step 1: ToolUseBlock.vue — delete `:id` binding (line 87)**

Find and delete the line `:id="'tool-use-' + block.id"` (or similar pattern) from `ui/src/components/message/ToolUseBlock.vue:87`.

- [ ] **Step 2: ToolResultBlock.vue — delete `:id` bindings (lines 56, 88)**

Find and delete the lines `:id="'tool-result-' + block.tool_use_id"` (or analogous prop bindings) from `ui/src/components/message/ToolResultBlock.vue` at lines 56 and 88.

### Task 8.2: Update composable JSDoc headers

**Files:**
- Modify: `ui/src/composables/useRawModal.ts` (line 27)
- Modify: `ui/src/composables/useDetailOrchestration.ts` (line 54)

- [ ] **Step 1: useRawModal.ts:27 JSDoc**

Change:
```typescript
/** Call in the provider component (DetailPanel) to set up shared raw JSON modal */
```
to:
```typescript
/** Call in the provider component (VDetailPage) to set up shared raw JSON modal */
```

- [ ] **Step 2: useDetailOrchestration.ts:54 JSDoc**

Change:
```typescript
/** Orchestration composable for DetailPanel — extracts data derivation and scroll logic */
```
to:
```typescript
/** Orchestration composable for DetailLayout — extracts toolMaps + scrollToResult/Call (selection-driven) */
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck:ui && npm run test:ui`
Expected: 0 errors; all tests pass.

- [ ] **Step 4: Commit final cleanup**

```bash
git add -u ui/
git commit -m "refactor(detail): cleanup orphan DOM id anchors + composable JSDoc

ToolUseBlock and ToolResultBlock no longer need the #tool-use-<id> /
#tool-result-<id> DOM markers (selectByObject replaces DOM querySelector).
Composable JSDoc retargeted: DetailPanel → VDetailPage / DetailLayout.

Activity Detail outline-as-main rewrite complete (RFC v3.1 commits 1a-8)."
```

---

## Plan Self-Review

**1. Spec coverage check (RFC v3.1):**

| RFC section | Plan task |
|---|---|
| §2.A SplitPane API | Commit 2 (Task 2.1) — all 10 API decisions encoded |
| §2.1 Component layout (19 new + DELETED list) | All 16 components in commits 3+4; deletes in 6+7+8 |
| §2.3 Selection union + assertNever + canary | Task 1.1 + 1.6 |
| §2.3.1 id table + fromId(id, ctx) | Task 1.1 + 1.2 tests |
| §2.3.2 ResolvedSelection + 'absent' | Task 1.5 |
| §2.3.3 render dispatch table | Tasks 3.1-3.6 (SelectedSlice + 13 Slice*) |
| §2.4 sticky watchers + auto-select + helpers + types | Tasks 1.3 (DegradeOf), 1.4 (composable) |
| §2.4.1 selection lifetime per-mount | VDetailPage instantiation in Task 5.3 |
| §2.5 provider rehoming | Task 5.3 (RawModal/DiffModal/ContentContext) + 1b (useDiffModal) |
| §2.6 OutlineHeader (search placeholder + noauto pill) | Task 4.3 |
| §2.7 positionMap split + scrollToResult/Call rewrite | Tasks 4.2 + 5.2 |
| §2.8 cross-stage semantic default + manual override | Task 3.9 (RelatedCrossStage) |
| §2.9 ghost outline + tooltip + teaching toast | Task 4.4 (OutlineTree ghost + tooltip); teaching toast NOT covered — add follow-up |
| §2.10 empty/degraded states | SliceAbsent (3.1) + placeholder in SelectedSlice (3.6) |
| §2.11 virtualization + flatNodes | Task 4.1 (useTocTree) + Task 4.4 (OutlineTree v-virtual-scroll) |
| §2.12 outline visual stage-aware subtrees | Task 4.1 |
| §2.13 in-slice find deferred | §9 D1 documented |
| §2.14 keyboard model | Task 4.4 (OutlineTree ↑↓←→) + 5.3 (j/k page-level, / focuses search, Esc back) |

**Gap found:** §2.9 first-degrade teaching toast (sessionStorage-flagged once-per-tab). Adding:

### Task 4.4b: Teaching toast on first sticky-degrade

**Files:**
- Modify: `ui/src/components/detail/outline/OutlineTree.vue`

- [ ] **Step 1: Add `watch` for first-degrade teaching toast**

In `OutlineTree.vue` script (after the existing `watch`), append:

```typescript
import { useToast } from "@/composables/useToast"  // assume project has this; if not, swap for in-line v-snackbar

const toast = useToast()
watch(
  () => props.stickyIntentId,
  (intent) => {
    if (!intent || intent === props.selectedId) return
    if (sessionStorage.getItem("detail.degrade-toast-shown")) return
    sessionStorage.setItem("detail.degrade-toast-shown", "1")
    toast.show("Selection auto-narrows when a node isn't in the next entry — outline shows the original intent in dotted gray.", 3000)
  },
)
```

If `@/composables/useToast` doesn't exist, fall back to mounting a `<v-snackbar>` in OutlineTree template (or hoist to VDetailPage). Confirm by `grep -n "useToast" ui/src/composables/` before implementing.

- [ ] **Step 2: Commit (fold into commit 4)**

Append this to the commit 4 task list above.

**2. Placeholder scan:** No "TBD", no "fill in details", no "Add appropriate error handling" — every step has either complete code or a precise grep/run command.

**3. Type consistency check:**

- `useDetailOrchestration` signature in Task 4.2 adds `opts?: { selectByObject?: ... }` — used in Task 5.3 by passing `selectByObject: (s) => outlineSelection.selectByObject(s)`. ✓
- `DetailLayout` props (entry/selection/selectedId/stickyIntentId/activeStage) match VDetailPage usage in Task 5.3. ✓
- `useTocTree(entry, activeStage)` 2-arg signature in Task 4.1 used by OutlineTree in Task 4.4. ✓
- `Selection.kind` literals consistent across toId/fromId/SelectedSlice/RelatedTabs (verified). ✓
- `useDiffModal()` API: `visible/original/effective/label/open/close` — matches Task 1b.1 spec and Task 5.3 VDetailPage usage. ✓

**4. Scope check:** Single feature (Activity Detail rewrite). All 9 commits ship through one PR or a stacked series. Each commit ends typecheck + test green.

---

Plan complete and saved to `docs/superpowers/plans/2026-06-15-activity-detail-outline-as-main.md`.

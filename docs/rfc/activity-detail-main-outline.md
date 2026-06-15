# RFC: Activity Detail — Outline as Main, Selection-driven Detail

**Status:** v3.1 — round-3 audit findings (R2''/R5''/R3'') incorporated 2026-06-15. Implementation-ready pending user sign-off.
**Author:** Brainstorming with user + 3 rounds × 3-5 reviewer adversarial audit.
**Driver:** 长远架构健康 + 交互模型重塑。用户原则："不将就，明显不同的功能不放进同一个 component"。
**Scope:** Activity Detail page (`/activity/:id`) UI 重构。后端 / API / 数据格式不变。

---

## Changelog

- **v3.1 (2026-06-15)**: Round-3 incorporated. **HIGH** fixes: (R2'' §2.7) `positionMap` split into per-side (`use`/`result`) sub-maps so `scrollToCall`/`scrollToResult` produce distinct positions; (R5'' #7) `sseList` re-classified stage-scoped to `Extract<StageId, 'upstream'|'forwarded'>` matching data model + §2.12 outline visual; (R3'' New4) OutlineHeader search wiring made explicit OR deferred — chose deferred (added to D2); (R3'' New1) commit-6 grep alternation spelled out fully with file-extension include filter; (R3'' New5) typecheck-canary patch mechanism spec'd as out-of-tree copy. **MEDIUM**: (R2'' §2.4) added explicit type signatures for `remapToNewEntry` / `degradeUntilExists` / `useResolvedSelection` return; (R5'' #1) ghost outline gets per-hover tooltip; (R5'' #5) `?noauto=1` UI affordance lands in OutlineHeader; (R3'' New6) commit 5 stays one-shot with documented rationale. **LOW**: ghost session-storage scope wording; SliceStage drops "headers 概要" line; `@deferred-rfc D2` JSDoc on orphan useDetailViewState fields; e2e selector includes tests/e2e-ui/vuetify-history.pw.ts:99 cleanup. Commits: 9 entries in §3 (1a/1b/2/3/4/5/6/7/8).
- v3 (2026-06-15): Round-2 incorporated.
- v2 (2026-06-15): Round-1 incorporated.
- v1 (2026-06-15): Initial draft.

---

## 1. Problem statement

### 1.1 当前结构

[VDetailPage.vue](../../ui/src/pages/vuetify/VDetailPage.vue): Header → DiagnosticSummary → StageTabs → 两栏 (TocTree 260px 辅助 | DetailPanel 整列)。每个 `Stage*` 渲染该 stage 的全部 messages + headers + sse。TOC 点击只做 scrollTo+highlight-flash。

### 1.2 用户提出的反转

> 全面改变 activity detail 界面：左侧树状栏目要成为主体，不再有右侧完整展示所有消息块的部分；当点击左侧树状栏中的消息块后，右侧展示它与它相关的块；也可以切换到 JSON 模式。

### 1.3 当前架构对该交互模型的阻碍（grep 核实）

| ID | Debt | Evidence |
|---|---|---|
| D1 | Outline 与 DetailPanel 数据不对等 | [useTocTree.ts:188-211](../../ui/src/composables/useTocTree.ts#L188-L211) |
| D2 | Stage* 只能渲染整列 | [DetailPanel.vue:165-217](../../ui/src/components/detail/DetailPanel.vue#L165-L217) |
| D3 | id 解析散落 | [useTocTree.ts:192-202](../../ui/src/composables/useTocTree.ts#L192-L202) + [VDetailPage.vue:55-64](../../ui/src/pages/vuetify/VDetailPage.vue#L55-L64) |
| D4 | 跨 stage 对应仅 effective↔inbound | [DetailPanel.vue:55-64](../../ui/src/components/detail/DetailPanel.vue#L55-L64) |
| D5 | Tool 配对只滚到另一处 | [useDetailOrchestration.ts:139-153](../../ui/src/composables/useDetailOrchestration.ts#L139-L153) |
| D6 | 左树 260px + 预览 30 字截断 | [useTocTree.ts:49-72](../../ui/src/composables/useTocTree.ts#L49-L72) |
| D7 | 非消息内容 outline 只是叶子 | — |
| D8 | `"request"` 重复 id（line 88 + 112）+ `"response"` 重复（123 + 129）→ fromId 不可往返 | [useTocTree.ts:88,112,123,129](../../ui/src/composables/useTocTree.ts#L88) |
| D9 | `toc-navigate` 孤儿 listener 等 dispatcher 死掉 | [MessageBlock.vue:54-58](../../ui/src/components/message/MessageBlock.vue#L54-L58), [SectionBlock.vue:49-53](../../ui/src/components/detail/SectionBlock.vue#L49-L53) |
| D10 | `HeadersSection.vue` 今天 0 importer | grep |
| D11 | `provideSharedResizeObserver` 今天 0 caller — runtime dead code (R1' F21) | grep |

### 1.4 不变量（v3 修订后）

| # | 决策 | 来源 |
|---|---|---|
| I1 | StageTabs 保留 | brainstorming |
| I2 | 左树 480px + 拖拽 + 持久化（具体 API §2.A） | brainstorming + R1' F18 |
| I3 | 右侧上下两区：上=选中切片，下=Related Tabs (Pair/Cross-stage/JSON) | brainstorming |
| I4 | Pair = tool_use ↔ tool_result | brainstorming |
| I5 | Cross-stage = 两两对，自动高亮 | brainstorming |
| I6 | **Entry 加载自动选中**：`entry.state === 'failed'` → `{kind:'metaError'}`（SliceMetaError 显示 `outboundResponse?.error` 或最后一个 `attempts[].error`，二者皆无则 fallback 到 lifecycle state + duration）；否则 → `{kind:'stage', stage:'inbound'}`（若 inbound 缺，按 effective/wire/upstream/forwarded 顺序退）；都无 → `null` 占位 | R5 + user re-confirm + R5' F4 + plan-time correction (HistoryEntry has no `meta` field) |
| I7 | 滚动单向（树→详情） | brainstorming |
| I8 | 非消息内容也归 outline 叶子 + Slice* | brainstorming |
| I9 | "不将就" | user |
| I10 | j/k 切 entry 时 **sticky selection**（按 kind+stage+indices 形状降级；都无→null） | R5 + user |
| I11 | StageTabs 切换时 **sticky selection**（swap selection.stage 保 indices；不存在→stage 顶；stage-less kinds 不动） | R5 + user |
| I12 | Cross-stage 默认 pair 按 selected.stage 语义驱动 + 手动覆盖持续至 selection.stage 变化 | R5 + user + R5' F3 |
| I13 | role-filter / type-filter / showOnlyRewritten / rewrite-nav **deferred 到 v2 RFC** | user choice on R6' MEDIUM filteredMessages question |
| I14 | `headers` 视为 **entry-global**（HeadersComparisonSection 已多 stage），不绑 stage | R5' F8 |
| I15 | `?noauto=1` URL query 禁用 auto-select；per-URL 不持久化 localStorage | R5 + R5' F6 |

---

## 2. Target architecture

### 2.A SplitPane primitive (NEW; R1' F18)

```ts
// ui/src/components/ui/SplitPane.vue
interface Props {
  storageKey: string             // REQUIRED — no default; no collision risk
  defaultLeftWidth?: number      // px, default 480
  minLeftWidth?: number          // px, default 320
  maxLeftWidth?: number          // px, default 800
  collapseBelowViewport?: number // px viewport-width threshold; below: hide right, left becomes drawer; default 768 (matches current VDetailPage media query)
}
defineEmits<{ 'resize-end': [px: number] }>()  // only fires on pointerup
// Slots (named, both required): #left, #right
```

Behavior contract:
- **Pointer events** (`pointerdown`/`move`/`up`)，覆盖触屏与鼠标
- **Clamping** on mount AND on window resize：`Math.min(max, Math.max(min, persisted ?? default))`
- **Drag handle hit area**: 12px wide invisible padding around 4px visible bar (`cursor: col-resize`)
- **Body cursor lock** during drag (`document.body.style.cursor = 'col-resize'` + `user-select: none`), 在 pointerup 还原
- **ARIA**: `role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max` + `tabindex="0"`
- **Keyboard resize when separator focused**: ←/→ 8px 步，Shift+←/→ 32px 步
- **Persistence**: `useLocalStorage(storageKey, defaultLeftWidth)` — 仅在 `resize-end` 时 commit (避免 60Hz 写)
- **Drawer mode** (`<collapseBelowViewport`): 右 pane 隐藏；左变 100% 宽度 drawer；恢复时回到 persisted width
- **No throttle on drag UI**: 拖动时直接更新 inline style；不触发持久化 ref，所以子组件不重渲染 (`OutlineTree` 不会因为拖动 jank)

Vitest (commit 2)：clamp-on-mount、clamp-on-window-resize、persistence round-trip (resize-end only)、pointer drag end-to-end、keyboard arrow resize、drawer mode。

### 2.1 Component layout

```
ui/src/
├── pages/vuetify/VDetailPage.vue
│   (Header + DiagnosticSummary + StageTabs + <DetailLayout>; 持 RawJsonModal + DiffModal 顶层挂载)
│
├── composables/
│   ├── useOutlineSelection.ts   # NEW — selection state, fromId(id, ctx)/toId, sticky degrade (DegradeOf<S>)
│   ├── useResolvedSelection.ts  # NEW — Selection → ResolvedSelection (discriminated; includes 'absent' variant)
│   ├── useDiffModal.ts          # NEW — singleton modal state (mirror of useRawModal)；DetailLayout 与 VDetailPage 共用
│   ├── useDetailStages.ts       # 沿用
│   ├── useDetailOrchestration.ts # 沿用 + 扩展 positionMap；删 filteredMessages + highlightBlock；改 scrollToResult/Call body
│   ├── useTocTree.ts            # 瘦身：tocTree (computed) + expandedNodes (Ref) + toggleNode + flatNodes (NEW computed for v-virtual-scroll); 删 scrollTo/ensureExpanded/activeId
│   └── useDetailViewState.ts    # 沿用（detailFilterRole/showOnlyRewritten 仍存在，但 DetailToolbar 不再消费 → deferred）
│
└── components/
    ├── ui/
    │   └── SplitPane.vue        # NEW (§2.A)
    │
    └── detail/
        ├── DetailLayout.vue     # NEW — 双栏 SplitPane；calls provideMessageActions(openDiff) using useDiffModal
        │
        ├── outline/
        │   ├── OutlineTree.vue  # 由 TocTree 重命名搬入；用 <v-virtual-scroll> + flatNodes；emit 'select'(Selection)
        │   └── OutlineHeader.vue # NEW (R1' F24) — 仅 search 输入框（v1 outline search 过滤，§2.13）；其他 toolbar 控件 deferred
        │
        ├── slice/               # 上区：选中切片
        │   ├── SelectedSlice.vue # 仅 switch(selection.kind) 分发 + assertNever 兜底
        │   ├── SliceStage.vue   # NEW (R1' F22 / R5'' #4)—stage 摘要：roles 数、tools 数、est tokens、message count、(response side) sse 帧数、(if error) 错误预览。NOT headers (headers 是 entry-global，独立 SliceHeaders)
        │   ├── SliceMessage.vue # 单 message（thin wrapper 包 MessageBlock + selection-flash CSS）
        │   ├── SliceBlock.vue   # 单 block (ContentRenderer)
        │   ├── SliceSystem.vue  # 系统消息
        │   ├── SliceSseEvents.vue # SSE 列表 (SseEventsSection)
        │   ├── SliceHeaders.vue # HeadersComparisonSection（entry-global，不绑 stage—R5' F8 / I14）
        │   ├── SliceAttempts.vue # AttemptsTimeline
        │   ├── SliceAttempt.vue # 单 attempt
        │   ├── SliceMeta.vue    # MetaInfo
        │   ├── SliceMetaError.vue       # NEW (R5' F7)
        │   ├── SliceResponse.vue        # upstream response root summary
        │   ├── SliceResponseError.vue   # NEW (R5' F7)
        │   └── SliceResponseContent.vue # NEW (R5' F7)
        │
        └── related/
            ├── RelatedTabs.vue  # <v-tabs> + <v-window>；watch: 当 active tab 变 disabled → 回退到 RelatedJson (R1' F25)
            ├── RelatedPair.vue  # tool_use ↔ tool_result
            ├── RelatedCrossStage.vue # 两两 diff (语义驱动 default + 手动 override)
            │   └── SideBySideSlice.vue # 复用 MessageDiffView / SseFrameDiff 内核
            └── RelatedJson.vue  # 原始 JSON
```

### 2.2 删除清单（v3，R3'/R6' 修订）

#### 文件级删除

| File | Commit | Verified |
|---|---|---|
| `DetailPanel.vue` | 6 | 0 ext consumer post-cutover |
| `stages/StageInbound.vue` … `StageMeta.vue` (7 files) | 6 | 0 |
| `DetailRequestSection.vue` | 6 | StageInbound/StageEffective 唯一 consumer 同 commit 删 |
| `DetailResponseSection.vue` | 6 | StageUpstream 唯一 consumer 同 commit 删 |
| `HeadersSection.vue` | 6 | 今天 0 importer (D10) |
| `ui/vitest/detail-request-section.test.ts` (R6' N2) | 6 | orphaned by DetailRequestSection 删除 |
| `useSharedResizeObserver.ts` (R1' F21 / D11) | 6 | `provideSharedResizeObserver` 0 caller — runtime dead today |
| `useMessageActions.ts` (R6' Task 7 fold-in) | 7 | 1-field interface → 折进 `useDiffModal`；mirror `useRawModal` 模式 |

#### 部分删除

| Item | File | Commit |
|---|---|---|
| `filteredMessages` computed + return + interface field (R6' Task 5) | useDetailOrchestration.ts:94-105,165 | 6 |
| `highlightBlock` private helper (R6' Task 5 LOW) | useDetailOrchestration.ts:48-52 | 5 (随 scrollToResult/Call body rewrite 同时) |
| DetailToolbar.vue 删除（用 OutlineHeader.vue 替代，仅 search；其他控件 deferred—I13） | DetailToolbar.vue 整文件 | 6 |
| `scrollTo` + `ensureExpanded` + DOM querySelector + `toc-navigate` dispatcher + `activeId` Ref + `UseTocTreeReturn.scrollTo` 字段 | useTocTree.ts | 7 |
| `addEventListener("toc-navigate")` + `handleTocNavigate` (R3' / R6') | MessageBlock.vue:53-58, SectionBlock.vue:48-53 | 7 |
| ↔ 按钮 template (lines 202-209) + `onJump` (148-151) + destructure (46) + call (150) | MessageBlock.vue | 7 |
| `jumpToCounterpart` field on interface + default noop + JSDoc (lines 11-16, 19, 29) | useMessageActions.ts | 7 (整文件一并删) |
| Test 中 `jumpToCounterpart` 断言 | detail-components.test.ts:121-150 | 7 |
| DOM 锚点 `:id="'tool-use-'..."` / `:id="'tool-result-'..."` | ToolUseBlock.vue, ToolResultBlock.vue | 8 |
| Composable JSDoc (`useRawModal.ts:27` / `useSharedResizeObserver.ts:30` 已随文件删 / `useDetailOrchestration.ts:54`) | — | 8 |

#### KEEP — 至少一个 surviving consumer

| Component | New consumer |
|---|---|
| SectionBlock | 所有 Slice* 包装 |
| MessageBlock | SliceMessage |
| ContentRenderer + 块组件 | SliceBlock |
| HeadersComparisonSection | SliceHeaders |
| SseEventsSection | SliceSseEvents |
| MessageDiffView | RelatedCrossStage / SideBySideSlice |
| SseFrameDiff | RelatedCrossStage / SideBySideSlice |
| MetaInfo | SliceMeta |
| AttemptsTimeline / AttemptDiff | SliceAttempts / SliceAttempt |
| TruncationDivider | SliceMessage（split-message 场景） |
| DiagnosticSummary / StageTabs | VDetailPage |
| DiffModal | VDetailPage（顶层挂载，state 通过 useDiffModal） |
| RawJsonModal | VDetailPage（顶层挂载，state 通过 useRawModal） |

### 2.3 Selection 类型 + Canonical id table（v3 修订；R2' Focus 1/2/6）

```ts
// useOutlineSelection.ts

export type StageId       = 'inbound' | 'effective' | 'wire' | 'upstream' | 'forwarded' | 'attempts' | 'meta'
export type MainStage     = Extract<StageId, 'inbound' | 'effective' | 'wire' | 'upstream' | 'forwarded'>
export type MessageBearingStage = Extract<StageId, 'inbound' | 'effective' | 'wire'>
export type ResponseSseStage    = Extract<StageId, 'upstream' | 'forwarded'>     // sseList stage scope (R5'' #7)

export type Selection =
  | { kind: 'stage';            stage: MainStage }                                   // attempts/meta have their own kinds
  | { kind: 'system';           stage: MessageBearingStage }
  | { kind: 'message';          stage: MessageBearingStage; messageIndex: number }
  | { kind: 'block';            stage: MessageBearingStage; messageIndex: number; blockIndex: number }
  | { kind: 'response' }                                                              // upstream response root
  | { kind: 'responseError' }
  | { kind: 'responseContent' }
  | { kind: 'sseList';          stage: ResponseSseStage }                            // R5'' #7: stage-scoped to {upstream, forwarded}
  | { kind: 'headers' }                                                               // entry-global (I14); no stage
  | { kind: 'attempts' }
  | { kind: 'attempt';          attemptIndex: number }                                // §9 reserved (outline doesn't expand in v1)
  | { kind: 'meta' }
  | { kind: 'metaError' }

export function assertNever(x: never): never {
  throw new Error(`Unhandled selection kind: ${JSON.stringify(x)}`)
}
```

**Pattern requirement (commit 1a)**：every `switch(selection.kind)` site MUST end in `default: return assertNever(s)`. Enforcement:
- **ESLint**: `@typescript-eslint/switch-exhaustiveness-check` enabled in `ui/eslint.config.*` (editor feedback)
- **Typecheck canary** (`tests/scripts/selection-exhaustiveness.test.ts`): spawns `bun run typecheck:ui` against patched tree (`Selection | {kind:'__canary'}`); asserts non-zero exit + error mentions every consumer site. Skipped from `bun test:ui`; runs in `test:typecheck-exhaustiveness` script + CI.

#### §2.3.1 — Canonical id ↔ Selection table（OutlineTree single-stage; `fromId` takes activeStage）

**Stage handling**: ids for stage-scoped kinds are stage-free. `fromId` requires `{activeStage}` context; `toId` discards stage. Stage transitions happen via §2.4 watch, not via id round-trip.

| String id | Selection (with `ctx.activeStage` injected for stage-bearing kinds) |
|---|---|
| `request` | `{ kind: 'stage', stage: ctx.activeStage as MainStage }` (if ctx.activeStage ∈ MessageBearingStage); else returns `null` (treat as unknown id) |
| `request.system` | `{ kind: 'system', stage: ctx.activeStage as MessageBearingStage }` (else null) |
| `request.messages.${i}` | `{ kind: 'message', stage: ctx.activeStage as MessageBearingStage, messageIndex: i }` (else null) |
| `request.messages.${i}.content.${j}` | `{ kind: 'block', stage: ctx.activeStage as MessageBearingStage, messageIndex: i, blockIndex: j }` (else null) |
| `response` | `{ kind: 'response' }` |
| `response.error` | `{ kind: 'responseError' }` |
| `response.content` | `{ kind: 'responseContent' }` |
| `section-sse-events` | `{ kind: 'sseList', stage: ctx.activeStage as ResponseSseStage }` (if ctx.activeStage ∈ {upstream, forwarded}; else null) — R5'' #7 |
| `httpHeaders` | `{ kind: 'headers' }` (entry-global; no stage) |
| `attempts` | `{ kind: 'attempts' }` |
| `attempts.${k}` | `{ kind: 'attempt', attemptIndex: k }` *(reserved, not emitted in v1 — see §9)* |
| `meta` | `{ kind: 'meta' }` |
| `meta.error` | `{ kind: 'metaError' }` |

**Round-trip invariant** (commit 1a tests):
- stage-bearing: `fromId(toId(s), {activeStage: s.stage}) === s`
- stage-less: `fromId(toId(s), {activeStage: 'inbound'}) === s` (activeStage 任意取)
- 非法 id：`fromId(unknownId, _)` 返回 `null`，`select(unknownId)` 调用 `console.warn` + no-op（测试覆盖）

**OutlineTree invariant**: 任一时刻 outline 展示 (a) `activeStage` 决定的 stage-scoped 子树：`activeStage ∈ MessageBearingStage` → `request` 子树（含 system + messages）；`activeStage ∈ ResponseSseStage` → `response` 子树（含 content/error + sseEvents）；其他 activeStage 值（attempts/meta 不作为 StageTab，见 §useDetailStages）→ 无 stage-scoped 子树。(b) entry-global 子树（headers/attempts/meta + metaError）跨 stage 切换始终渲染。

#### §2.3.2 — ResolvedSelection（R2' Focus 3）

```ts
export type ResolvedSelection =
  | { kind: 'stage';           selection: Extract<Selection, {kind:'stage'}>;  stageData: StageData }
  | { kind: 'system';          selection: Extract<Selection, {kind:'system'}>; systemText: string }
  | { kind: 'message';         selection: Extract<Selection, {kind:'message'}>; message: MessageContent; stageData: StageData }
  | { kind: 'block';           selection: Extract<Selection, {kind:'block'}>;   block: ContentBlock; message: MessageContent; stageData: StageData }
  | { kind: 'response';        selection: Extract<Selection, {kind:'response'}>; response: UpstreamResponse }
  | { kind: 'responseError';   selection: ...; error: NonNullable<UpstreamResponse['error']> }
  | { kind: 'responseContent'; selection: ...; content: NonNullable<UpstreamResponse['content']> }
  | { kind: 'sseList';         selection: ...; events: Array<SseEvent> }
  | { kind: 'headers';         selection: ...; headers: HeadersRecord }
  | { kind: 'attempts';        selection: ...; attempts: Array<Attempt> }
  | { kind: 'attempt';         selection: ...; attempt: Attempt }
  | { kind: 'meta';            selection: ...; entry: HistoryEntry }                                                                          // SliceMeta reads state/durationMs/attemptCount/transport/queueWaitMs etc directly from entry
  | { kind: 'metaError';       selection: ...; error: string; source: 'outboundResponse' | 'lastAttempt' | 'lifecycleState' }                  // outboundResponse.error || attempts[last].error || `state=${state}`
  | { kind: 'absent';          original: Selection }                              // discriminated null (R2' Focus 3)
```

**`useResolvedSelection` return type**: `Ref<ResolvedSelection | null>`. SelectedSlice handles `null` (no selection at all — placeholder state per §2.10) **separately** from `{kind:'absent'}` (selection exists but resolution failed — shows kind-specific absent fallback per §2.3.3). The `absent` arm dispatches on `original.kind` for the empty-fallback copy:

```ts
// SelectedSlice.vue sketch
if (resolved.value == null) return <Placeholder />        // null branch first
switch (resolved.value.kind) {
  ...
  case 'absent':
    return <SliceAbsent :originalKind="resolved.value.original.kind" />  // dispatch by original.kind
  default: return assertNever(resolved.value)
}
```

**所有 Slice* / Related* 消费 `useResolvedSelection` 而非直接索引 `entry.value.X.messages[i].content[j]`**——absent 处理与解析在一处；switch 仍可 exhaustive 配 `assertNever`。

#### §2.3.3 — Render dispatch table（R5' F7）

| Selection.kind | SelectedSlice 渲染 | Empty fallback (resolved.kind = 'absent') |
|---|---|---|
| `stage` | SliceStage | "stage absent" |
| `system` | SliceSystem | "system absent" |
| `message` | SliceMessage | "message absent at this stage; outline ghost shows original" |
| `block` | SliceBlock | "block absent; degraded to parent message" |
| `response` | SliceResponse | "no upstream response" |
| `responseError` | SliceResponseError | "no upstream error captured" |
| `responseContent` | SliceResponseContent | "no response content" |
| `sseList` | SliceSseEvents | "no sse frames" |
| `headers` | SliceHeaders | "no headers captured" |
| `attempts` | SliceAttempts | "no attempts" |
| `attempt` | SliceAttempt | "attempt absent" |
| `meta` | SliceMeta | "no meta" |
| `metaError` | SliceMetaError | "no error captured" |

### 2.4 Sticky selection + auto-select (R5 + R5' F1)

`useOutlineSelection`（VDetailPage 内 instantiate；状态生命周期 = VDetailPage mount；route 离开会丢——见 §2.4.1）：

**Helper signatures** (R2'' MEDIUM)：

```ts
function pickAutoSelect(entry: HistoryEntry | null): Selection | null
function remapToNewEntry(s: Selection, e: HistoryEntry): Selection | null      // 形状保持；不存在返 null
function resolveExists(s: Selection, e: HistoryEntry): boolean                  // 纯存在性检查
function degradeOnce<S extends Selection>(s: S): DegradeOf<S> | null            // 单步降级
function degradeUntilExists(s: Selection, e: HistoryEntry): Selection | null {  // 循环降级到第一个存在
  let cur: Selection | null = s
  while (cur && !resolveExists(cur, e)) cur = degradeOnce(cur) as Selection | null
  return cur
}
const isMessageBearing = (s: StageId): s is MessageBearingStage =>
  s === 'inbound' || s === 'effective' || s === 'wire'
const isMainStage = (s: StageId): s is MainStage =>
  s !== 'attempts' && s !== 'meta'
const isResponseSse = (s: StageId): s is ResponseSseStage =>
  s === 'upstream' || s === 'forwarded'
```

```ts
const selection = ref<Selection | null>(null)
const stickyIntent = ref<Selection | null>(null)    // 原始意图（degrade 前），用于 ghost (§2.9)
const firstLoadDone = ref(false)

// 1. Entry change (j/k)
watch(entry, (newEntry) => {
  if (!newEntry) return

  // §I15: noauto=1 query disables auto-select & sticky re-fire
  if (route.query.noauto === '1' || route.query.noauto === 'true') {
    if (!firstLoadDone.value) selection.value = null
    firstLoadDone.value = true
    return
  }

  if (!firstLoadDone.value) {
    // First mount: auto-select
    selection.value = pickAutoSelect(newEntry)
    stickyIntent.value = selection.value
    firstLoadDone.value = true
    return
  }

  if (selection.value == null) {
    // Sticky degraded to null on previous entry; reset to auto-select
    selection.value = pickAutoSelect(newEntry)
    stickyIntent.value = selection.value
    return
  }

  // Try to preserve shape; remember intent for ghost
  stickyIntent.value = selection.value
  const remapped = remapToNewEntry(selection.value, newEntry)
  if (remapped) {
    selection.value = remapped          // single write (no degrade ladder spam) — R1' F20
    return
  }
  const degraded = degradeUntilExists(selection.value, newEntry)  // walk down DegradeOf chain to first present
  selection.value = degraded            // single write
})

// 2. Stage change
watch(activeStage, (newStage: StageId) => {
  if (!selection.value) return
  if (!('stage' in selection.value)) return        // stage-less kinds unaffected (headers/attempts/meta/response/responseError/responseContent/metaError)
  stickyIntent.value = selection.value
  // R2'' LOW: explicit narrow per kind instead of `as Selection` cast — type-safe stage swap
  let remapped: Selection
  switch (selection.value.kind) {
    case 'stage':
      if (!isMainStage(newStage)) return
      remapped = { kind: 'stage', stage: newStage }
      break
    case 'system': case 'message': case 'block':
      if (!isMessageBearing(newStage)) {
        selection.value = isMainStage(newStage) ? { kind: 'stage', stage: newStage } : null
        return
      }
      remapped = { ...selection.value, stage: newStage } as Selection
      break
    case 'sseList':
      if (!isResponseSse(newStage)) {
        selection.value = isMainStage(newStage) ? { kind: 'stage', stage: newStage } : null
        return
      }
      remapped = { kind: 'sseList', stage: newStage }
      break
    default: return assertNever(selection.value as never)
  }
  selection.value = (resolveExists(remapped, entry.value!)
                     ? remapped
                     : isMainStage(newStage) ? { kind: 'stage', stage: newStage } : null)   // single write
})

function pickAutoSelect(entry: HistoryEntry | null): Selection | null {
  if (!entry) return null
  if (entry.state === 'failed') return { kind: 'metaError' }              // I6 precise (R5' F4 + HistoryEntry has no `meta` field)
  if (entry.inboundRequest) return { kind: 'stage', stage: 'inbound' }
  for (const s of ['effective', 'wire', 'upstream', 'forwarded'] as const) {
    if (entry[`${s}Request` as keyof HistoryEntry] || entry[`${s}Response` as keyof HistoryEntry]) {
      return { kind: 'stage', stage: s }
    }
  }
  return null
}
```

`DegradeOf<S>` 类型约束（R2' Focus 4）保证 compile-time 安全：

```ts
type DegradeOf<S extends Selection> =
  S extends { kind: 'block';   stage: infer St; messageIndex: infer I }
    ? { kind: 'message'; stage: St & MessageBearingStage; messageIndex: I & number }
  : S extends { kind: 'message'; stage: infer St }
    ? { kind: 'stage';   stage: St & MainStage }
  : S extends { kind: 'attempt' }
    ? { kind: 'attempts' }
  : S extends { kind: 'system' | 'stage' | 'response' | 'responseError' | 'responseContent'
              | 'sseList' | 'headers' | 'attempts' | 'meta' | 'metaError' }
    ? null
  : never

function degradeOnce<S extends Selection>(s: S): DegradeOf<S> | null
```

**Single-write guarantee** (R1' F20)：每次 entry/stage change 至多写一次 `selection.value` —— compute target，then assign。SelectedSlice 的 `watch(selection)` 至多触发一次/事件。

#### §2.4.1 — Selection lifetime (R1' F26)

| Navigation | Selection state |
|---|---|
| j/k between adjacent entries (same VDetailPage mount) | STICKY via watch #1 |
| StageTabs click | STICKY via watch #2 |
| Route leave + re-enter `/activity/:id` | LOST (VDetailPage 非 keep-alive；fresh mount → pickAutoSelect) |
| Browser back/forward | LOST |
| Page reload | LOST |

Cross-mount persistence (URL `?sel=request.messages.3.content.0` 或 Pinia store) **deferred 到 v2 RFC** (§9)。

### 2.5 Provider rehoming map (commit-5 cutover 契约)

| Provider / Modal / Watch | 旧 owner | 新 owner | 备注 |
|---|---|---|---|
| `provideRawModal()` | DetailPanel:68 | **VDetailPage** | 4 consumers (MessageBlock/ContentBlockWrapper/SystemMessage/SectionBlock) — R1' F21 修订计数 |
| `<RawJsonModal>` | DetailPanel:221-227 | VDetailPage | |
| `useDiffModal()` (NEW; mirror of useRawModal) | — | VDetailPage (consume state) + DetailLayout (call `.open()`) | R1' F19 / R3' N6 fix — module-scoped singleton ref；解决 DetailLayout↔modal 桥 |
| `<DiffModal>` | DetailPanel:230-236 | VDetailPage | state from `useDiffModal()` |
| `provideMessageActions({openDiff})` (commit 5; jumpToCounterpart 是 stub no-op) | DetailPanel:48-65 | **DetailLayout** | commit 7 整文件删（折进 useDiffModal） |
| `provideContentContext(...)` | DetailPanel:91-99 | **VDetailPage** | scrollToResult/Call body 见 §2.7 |
| `watch(entry, scrollToTop)` → 改 `watch(selection, scrollToTop)` | DetailPanel:126-132 | **SelectedSlice** | 单写保证 (§2.4) 避免 degrade 链多次触发 |

### 2.6 OutlineHeader (取代 DetailToolbar; I13)

OutlineHeader.vue 含：

1. **Search input** — placeholder (`<v-text-field placeholder="Search outline...">`)，绑 `useDetailViewState.detailSearch`。**实际 filter→flatNodes 逻辑 DEFERRED 到 v2 RFC（§9 D2）**——v1 输入框只接收文本、不影响 flatNodes 可见性；输入框存在是为了 OutlineHeader 容器有内容且未来无需重排版（R3'' New4）。
2. **`?noauto=1` pill**（R5'' #5）— 当 `route.query.noauto === '1'` 时渲染一个 `<v-chip closable>Auto-select: off</v-chip>`；点击 × → `router.replace({ query: { ...route.query, noauto: undefined } })`。其余时间不渲染。

其余 DetailToolbar 控件 deferred（I13 + §9 D2）：role-filter / type-filter / showOnlyRewritten / aggregateTools / Export-duplicate / rewrite-stats / rewrite-nav。Export 按钮 VDetailPage Header 已有 (line 229-237)。

`detailFilterRole` / `showOnlyRewritten` / `aggregateTools` 字段仍存在于 useDetailViewState（commit 6 加 `// @deferred-rfc D2 — see RFC §9` JSDoc，R2'' LOW），但本 RFC 范围内 outline 之外**无 UI 触达**；`aggregateTools` 仍由 `provideContentContext` 透传给 ToolUseBlock/ToolResultBlock（这是被原则 9 carve-out 保留的"示范价值死代码"——不再被 UI 触发但仍被 provider 与 consumer 引用）。

### 2.7 scrollToResult/Call 改写 (R1' F5 / R2' Focus 7 / R3' N4 / R2'' HIGH)

`positionMap` 必须**分 use / result 两侧**——同一 `tool_use_id` 既是 tool_use block 的 `id`、也是 tool_result block 的 `tool_use_id`，必须在 map 中区分位置 (R2'' HIGH)：

```ts
// useDetailOrchestration.ts toolMaps computed
type PerStageLoc = {
  inbound?:   { messageIndex: number; blockIndex: number }
  effective?: { messageIndex: number; blockIndex: number }
  wire?:      { messageIndex: number; blockIndex: number }
}

toolMaps = {
  resultMap: Record<string, ContentBlock>,                                    // unchanged
  nameMap:   Record<string, string>,                                          // unchanged
  positionMap: Record<string, { use?: PerStageLoc; result?: PerStageLoc }>,   // NEW — split per side
}

function lookupPos(id: string, side: 'use' | 'result'): { stage: MessageBearingStage; messageIndex: number; blockIndex: number } | null {
  const entry = toolMaps.value.positionMap[id]?.[side]
  if (!entry) return null
  for (const stage of ['effective', 'inbound', 'wire'] as const) {
    if (entry[stage]) return { stage, ...entry[stage]! }
  }
  return null
}

function scrollToResult(toolUseId: string): void {
  const loc = lookupPos(toolUseId, 'result')
  if (!loc) { showToast('Tool result not found at any stage'); return }
  outlineSelection.selectByObject({ kind: 'block', ...loc })
}
function scrollToCall(toolUseId: string): void {
  const loc = lookupPos(toolUseId, 'use')
  if (!loc) { showToast('Tool call not found at any stage'); return }
  outlineSelection.selectByObject({ kind: 'block', ...loc })
}
```

Filling: in the same single-pass loop that builds `resultMap`/`nameMap` over `inboundRequest.messages` + `effectiveRequest.messages` (+ wire if present), encounter each `tool_use` block → write to `positionMap[block.id].use[stage]`; encounter each `tool_result` block → write to `positionMap[block.tool_use_id].result[stage]`. Both sides populated independently; no collision (R2'' HIGH fix).

Fallback chain `effective → inbound → wire` (no `upstream` — R3' N4); response-side tool results are reached via `selectByObject({kind:'responseContent'})` separately.

`highlightBlock` private helper (`useDetailOrchestration.ts:48-52`) 同 commit (5) 删除（无消费者）。

**Visual feedback** for selection change：SelectedSlice 在 `watch(selection)` 加 600ms CSS `--selection-flash` class 触发（取代 highlight-flash）。

### 2.8 Cross-stage 语义对 + manual override (R5' F3 修订)

```ts
// RelatedCrossStage 内
const manualOverride = ref<{ left: StageId; right: StageId } | null>(null)
const prevSelectionStage = ref<StageId | null>(null)

// Drop override only when selection.stage changes (not on every selection change — R5' F3)
watch(() => 'stage' in (selection.value ?? {}) ? (selection.value as any).stage : null, (newStage) => {
  if (newStage !== prevSelectionStage.value && newStage != null) {
    manualOverride.value = null
  }
  prevSelectionStage.value = newStage
})

const effectivePair = computed(() => manualOverride.value ?? defaultPairFor(selection.value, activeStage.value))
```

`defaultPairFor`：

| selected.stage (== activeStage from StageTabs) | left | right | 语义 |
|---|---|---|---|
| inbound / effective | inbound | effective | "sanitize 做了什么" |
| wire | effective | wire | "wire vs effective 差异" |
| upstream | wire | upstream | "我们发了什么 vs 上游回了什么" |
| forwarded | upstream | forwarded | "我们转给客户端 vs 上游原回" |
| attempts / meta | n/a | n/a | tab disabled |

selection 为 stage-less kind (headers/attempts/meta/response/responseError/responseContent/metaError): cross-stage tab **disabled**（不破坏 manualOverride）。

selection 为 `sseList` (stage-bearing on `ResponseSseStage`): cross-stage tab **enabled**，默认对 = `upstream vs forwarded`（"上游原 SSE vs 我们转给客户端的 SSE，含合成 heartbeat"——这是 SSE 诊断的核心比对）。

absent-at-stage 显示 "absent at <stage>" 占位。

### 2.9 Sticky-degrade 视觉反馈：ghost 取代 toast (R5' F2 / R5'' #1, #2)

不再每次 toast。OutlineTree 渲染 **ghost outline**：

- `stickyIntent` (§2.4) 存原始意图 Selection
- OutlineTree 在 `flatNodes` 中查找 `stickyIntent` 对应 id；如该 id 存在（祖先路径有节点），以 **dotted border + 40% opacity** 渲染该节点（"would-be selection"）
- 当前实际 selection 仍以正常高亮渲染
- 若 stickyIntent 在新 entry 完全不存在（没匹配 id），不渲染 ghost
- 当 `selection === stickyIntent`（无 degrade），不渲染 ghost
- **每个 ghost 节点带 hover tooltip**（R5'' #1）：`"Not present in this entry — original selection"`（VTooltip 包 OutlineRow when `ghost === true`）

**First-degrade teaching toast** (R5'' #2 scope clarification)：一次性，scope = **browser tab**（sessionStorage flag `detail.degrade-toast-shown`）；新 tab / 私密模式重新显示（intentional——fresh context warrants re-teaching）。
> "Selection auto-narrows when a node isn't in the next entry — outline shows the original intent in dotted gray."

3s 自动消失。

### 2.10 Empty / degraded states (扩 R5 F9)

| Condition | Outline | Right pane |
|---|---|---|
| Entry 完全空（无 inbound/effective/wire/upstream） | 只剩 attempts/meta 子树 + entry-global leaves | auto-select fall to meta；若 meta 也空 → "No content captured" 占位 |
| Selected stage 无内容 | "(empty)" leaf | "No content in <stage>." + 跳到有内容的 stage 链接 |
| Sticky degrade target absent | nearest ancestor 选中 + ghost（§2.9） | fallback parent；首次 degrade 整 session 出 teaching toast |
| Slice render error | outline 不受影响 | `<ErrorBoundary>` per-slice: "Could not render `<kind>`. Show raw JSON" 按钮 → 切到 RelatedJson |
| selection = null (auto-select 关闭或 entry 完全空) | 全树正常 | "Select a node from the outline to view details." |

### 2.11 Virtual scrolling (R5 + R1' F23)

Vuetify 4 `<v-virtual-scroll>` flat-only。OutlineTree 维护：

```ts
// useTocTree.ts — NEW computed
const flatNodes = computed(() => flattenWithDepth(tocTree.value, expandedNodes.value))
// returns Array<{ node: TocNode; depth: number; expanded: boolean }>

// OutlineTree.vue
<v-virtual-scroll :items="flatNodes" item-key="node.id" :item-height="32">
  <template #default="{ item }">
    <OutlineRow :node="item.node" :depth="item.depth" :expanded="item.expanded"
                :selected="item.node.id === selectedId"
                :ghost="item.node.id === stickyIntentId"
                @click="$emit('select', toSelection(item.node))"
                @toggle="useTocTree().toggleNode(item.node.id)" />
  </template>
</v-virtual-scroll>
```

无 200 阈值——所有规模统一虚拟（实现简单 + 性能可预测）。

Selection 同步：watch `selectedId`，若 offscreen → `vScrollRef.value?.scrollToIndex(flatNodes.findIndex(...))`。
键盘 ↑/↓ 操作 `flatNodes` 列表（跳过 collapsed 父的子）。
Expand state 按 id 持久化（已在 useTocTree）；entry 变化时同名 id 存在则保留展开，否则收起。

### 2.12 Outline 视觉分隔 (R5 F6 / R5'' #7)

```
▾ request           ← stage-scoped to request stages (inbound / effective / wire — per StageTabs)
  ▾ system
  ▾ messages
▾ response          ← stage-scoped to response stages (upstream / forwarded — per StageTabs)
  ▸ content / error
  ▸ sseEvents       ← R5'' #7: sseList 是 response-side per-stage data，归 response 子树
──── entry-global ────
▸ httpHeaders        ← I14: 全局 headers，不绑 stage
▸ attempts
▸ meta / error
```

一条 CSS 分隔线 + caption。`useTocTree.ts` 的 `tocTree` computed 必须按 `activeStage` 切换 outline 子树构造：当 `activeStage ∈ MessageBearingStage` → 渲染 `request` 子树、不渲染 `response`+`sseEvents`；当 `activeStage ∈ ResponseSseStage` → 渲染 `response`+`sseEvents` 子树、不渲染 `request`；entry-global 部分始终渲染。

### 2.13 In-slice find (deferred)

v1 仅依赖浏览器原生 Ctrl-F。
deferred 到 v2 RFC：outline 高级 search syntax + in-slice highlight & jump + `DetailPanel.vue:110-121` 的 search→scroll-to-first-match 行为（R3' N8 文档化）。

### 2.14 Keyboard model (R5 F8)

| Action | Behavior |
|---|---|
| j / k | **页面级**, 切 entry（page-level handler，不被 outline 拦） |
| ↑ / ↓ (OutlineTree focused) | move selection (flatNodes) |
| ← / → (OutlineTree focused) | collapse / expand 当前节点 |
| Enter (OutlineTree focused) | 焦点移到右侧 SelectedSlice |
| Tab from outline | → SelectedSlice → RelatedTabs |
| 1 / 2 / 3 (RelatedTabs focused) | 切 Pair / Cross-stage / JSON |
| Esc | 关 modal（无 modal 时 no-op，**不**清 selection） |
| / | focus OutlineHeader search |
| ←/→ (SplitPane handle focused) | 8px 步 resize；Shift+ 32px |
| g/G, Ctrl-F intercept | deferred |

OutlineTree 的 keydown 对 `event.key === 'j' || 'k'` 直接 `return`（让 page handler 接管）。Playwright e2e：focus outline → j → entry 推进；focus input → 'j' → input 接收。

---

## 3. Commit invariants (v3：11 commits)

每个 commit 终态：typecheck-green、bun test + vitest 全绿、UI 不半破。

| # | Commit | 不变量 |
|---|---|---|
| **1a** | `feat(detail): Selection types + useOutlineSelection + useResolvedSelection` | Selection union + canonical id table + fromId(id, ctx) / toId + `DegradeOf<S>` + sticky watchers + pickAutoSelect + ESLint exhaustiveness + typecheck-canary test。Unit tests：每 kind toId/fromId 往返；sticky entry-change/stage-change/null-recover；pickAutoSelect 4 matrix (meta-error / inbound-present / fallback-stage / empty)；ResolvedSelection 'absent' 路径 |
| **1b** | `feat(detail): useDiffModal` | mirror of useRawModal；module-scope state；unit test |
| **2** | `feat(ui): SplitPane primitive` | §2.A 完整 API；vitest 6 个（clamp/persistence/pointer-drag/keyboard-resize/drawer/resize-end-debounce）；CLAUDE.md/README stale SplitPane 行更新为 "now exists" |
| **3** | `feat(detail): Slice* (13) + Related* (3) + RelatedTabs` | 全部组件存在，未挂载；每个独立 vitest。RelatedTabs: tab disabled 时 active→RelatedJson fallback；v-window-item 内 useRawModal inject 不抛 |
| **4** | `feat(detail): OutlineTree + OutlineHeader + DetailLayout + flatNodes` | OutlineTree 用 `<v-virtual-scroll>` 渲染 flatNodes；OutlineHeader 仅 search；DetailLayout 用 SplitPane 包左右；DetailLayout 通过 useDiffModal 持 openDiff；未挂载到 VDetailPage |
| **5** | `feat(detail): cutover — VDetailPage 切到 DetailLayout` ← **用户验证点（one-shot by design）** | **不拆分理由 (R3'' New6)**：拆 5a/5b 中间状态会让右 pane 变 "已挂 DetailLayout 但 selection 不工作" 的死壳——既不是"显示旧"也不是"显示新"，比 one-shot 更违反"intermediate commits not half-broken"原则。所以一次性合拢：StageTabs 在；左 480 拖拽；auto-select 生效；sticky j/k + stage 切换；keyboard ↑/↓/Enter/Tab/1-2-3/Esc/`/`；**provider rehoming (§2.5) 完成无 inject 抛错**；scrollToResult/Call 改写 + highlightBlock 删；e2e selector 同 commit 更新 `tests/e2e-ui/vuetify-history.pw.ts:72` + `:99`（包含 `detail-body` className 引用，R3'' New5 增补）→ 改为 `[data-testid='detail-scroll-container']`，DetailLayout 右侧 scroll 容器加该 testid；typecheck + bun test + vitest 全绿；用户手测 |
| **6** | `refactor(detail): delete DetailPanel + Stage* + DetailRequestSection + DetailResponseSection + HeadersSection + DetailToolbar + useSharedResizeObserver + detail-request-section.test.ts + filteredMessages` | 13 文件/部分删；grep precise (R3'' New1)：<br>`grep -rnE 'DetailPanel\.vue\|Stage(Inbound\|Effective\|Wire\|Upstream\|Forwarded\|Attempts\|Meta)\.vue\|DetailRequestSection\|DetailResponseSection\|HeadersSection\|DetailToolbar\|filteredMessages\|useSharedResizeObserver' ui/src --include='*.ts' --include='*.vue' --exclude-dir=dist --exclude-dir=node_modules` 零残留；docs (`ui/CLAUDE.md:141,166,180`, `ui/README.md:40,110`) 同 commit 更新；useDetailViewState 的 `detailFilterRole/detailFilterType/showOnlyRewritten/aggregateTools` 加 `// @deferred-rfc D2 — see RFC §9` JSDoc 标注（R2'' LOW） |
| **7** | `refactor(detail): cleanup useTocTree.scrollTo + toc-navigate orphans + jumpToCounterpart + useMessageActions fold-in` | useTocTree.scrollTo/ensureExpanded/activeId/dispatcher 删；MessageBlock/SectionBlock 的 toc-navigate listener+handler 删；MessageBlock ↔ 按钮 + onJump + 调用删；useMessageActions.ts 整文件删（openDiff 折进 useDiffModal）；detail-components.test.ts 中 jumpToCounterpart 断言删；`grep -rnE 'toc-navigate\|jumpToCounterpart' ui/ --include='*.ts' --include='*.vue' --exclude-dir=dist --exclude-dir=node_modules` 零残留 |
| **8** | `refactor(detail): cleanup orphan DOM anchors + composable docs` | ToolUseBlock/ToolResultBlock 的 tool-use/tool-result DOM `:id` 删；composable JSDoc 头改指 VDetailPage/DetailLayout |

**Commit 5 是用户验证点**——后续 3 个 commit 是纯清理。

---

## 4. Testing strategy

### 4.1 Unit (bun test)
- `useOutlineSelection.test.ts`：往返 + sticky 3 watcher + pickAutoSelect 4 matrix + selection-cleared-then-jk re-auto-select（R5' F1）
- `useResolvedSelection.test.ts`：每 kind 解析 + 'absent' 路径 + entry 重渲染
- `tool-position-map.test.ts`：双路填充 + lookupPos fallback effective→inbound→wire
- `cross-stage-pair.test.ts`：默认按 selected.stage + manualOverride 持续直到 selection.stage 变化（R5' F3）
- `flat-nodes.test.ts`：flatten 顺序 + expand-state 保留 + 同名 id 跨 entry 保留
- `selection-exhaustiveness.test.ts` (typecheck canary, **out-of-tree copy mechanism — R3'' New5 HIGH**)：
  1. `mktemp -d /tmp/sel-canary.XXXXXX` 创建 working copy 目录
  2. `cp -r ui/src $WORKDIR/src` + `cp ui/tsconfig.json $WORKDIR/tsconfig.canary.json`（patched paths）
  3. `sed -i 's/^export type Selection =/export type Selection = | { kind: "__canary" } |/' $WORKDIR/src/composables/useOutlineSelection.ts` —— 在 union 注入 canary variant
  4. `bun --bun tsc --project $WORKDIR/tsconfig.canary.json --noEmit 2>&1 | tee $WORKDIR/tsc.log`
  5. 断言 exit code ≠ 0 **并且** `tsc.log` 至少包含每个 consumer site 的文件名（SelectedSlice.vue、useResolvedSelection.ts、degradeOnce 调用点、toId、fromId、Slice* 12 个文件、Related* 3 个）
  6. `finally`: `rm -rf $WORKDIR`（无 in-place mutation 风险；test 进程 crash 也只留 /tmp 残留）
  7. 不进入 `bun run test:backend` 全集；专用脚本 `bun run test:typecheck-exhaustiveness`（新增 package.json 条目）+ CI 单独 step

### 4.2 Component (vitest)
- 每个 Slice* (13) + Related* (3) + OutlineTree + OutlineHeader + DetailLayout + SplitPane 独立 mount test
- RelatedPair disabled on non-tool block；RelatedCrossStage disabled on stage-less
- RelatedTabs：active tab 变 disabled → fallback to RelatedJson
- RelatedTabs：v-window-item 内 MessageBlock 的 useRawModal inject 不抛
- Empty/degraded states (§2.10) 每行
- OutlineTree：ghost rendered only on degrade；selection === stickyIntent 时无 ghost
- Keyboard：↑/↓ 移 selection；Tab 落 RelatedTabs；1-2-3 切 tab；j/k 不被 outline 拦
- SplitPane：clamp-on-mount/resize、persistence (resize-end only)、drawer mode

### 4.3 E2E (Playwright)
- `tests/e2e-ui/vuetify-history.pw.ts:72` 改为 `[data-testid='detail-scroll-container']` selector（commit 5）
- 现有 detail 页测试断言更新："右侧整列" → "选中后右侧出现 Slice"
- `?noauto=1` 链接 → 右侧空 → 点 outline → 选中 → j → 下一 entry 仍空
- focus outline → j → entry 推进；focus search → 'j' → input 接收

### 4.4 Doc (commit 6)
- `ui/CLAUDE.md:141`（render pipeline 图）
- `ui/CLAUDE.md:166`（"VueUse 使用现状"中 SplitPane 行）— 已存在改为对应新文件
- `ui/CLAUDE.md:180`（"DetailPanel 过大"项删除）
- `ui/README.md:40,110`
- `useRawModal.ts:27` / `useDetailOrchestration.ts:54` JSDoc 头改指 VDetailPage（useSharedResizeObserver 已删）

---

## 5. Subagent audit consensus

### Round 1 (2026-06-15) — completed
5 reviewers (R1/R2/R3/R5/R6) parallel against v1. F1–F17 incorporated → v2.

### Round 2 (2026-06-15) — completed
5 reviewers (R1'/R2'/R3'/R5'/R6') parallel against v2. F18–F26 + N1–N9 + R5' findings 1-8 + R6' Tasks 1-8 incorporated → v3。User decision on filteredMessages → deferred (I13)。

### Round 3 (2026-06-15) — completed → v3.1
3 reviewers (R2''/R5''/R3'') against v3. All round-2 findings confirmed RESOLVED. NEW findings absorbed: R2'' HIGH (positionMap use/result split — §2.7), R5'' #7 HIGH (sseList stage-scoped to ResponseSseStage — §2.3 + §2.12), R3'' New4 HIGH (OutlineHeader filter → DEFERRED to §9 D2; placeholder input only — §2.6), R3'' New1 HIGH (commit-6 grep alternation spelled fully — §3), R3'' New5 HIGH (typecheck-canary uses out-of-tree mktemp copy — §4.1), plus 4 MEDIUM + 4 LOW polish edits. Commit count: 9 entries in §3.

### Round 4 (2026-06-15) — completed
3 reviewers (R2'''/R5'''/R3''') against v3.1. All 16 round-3 findings verified FIXED with file:line evidence. Main agent hand-verified each subagent claim against actual RFC lines (per memory feedback-subagent-feedback-also-critically-verify); caught 2 residual inconsistencies subagents missed: (i) §2.3.1 "OutlineTree invariant" still listed sseList as entry-global despite §2.12 having it stage-scoped — fixed; (ii) §2.8 cross-stage disabled list still listed sseList as stage-less — fixed (now enabled with default upstream-vs-forwarded SSE diff). Plus changelog "Commits remain 11" miscount → "9 entries in §3".

**Consensus reached: v3.1 implementation-ready.** Four-round adversarial audit (5+5+3+3 = 16 reviewer-passes) + user re-confirmation on 4 invariants + 1 deferred-scope decision + main-agent hand-verification meets project methodology bar.

---

## 6. Open questions

无。v1 Q1-Q5 解析完毕。

---

## 7. Out of scope

- 后端 API / history 数据结构 / ws 协议
- VActivityPage / VDashboardPage / VModelsPage / VConfigPage
- DiagnosticSummary / StageTabs 内部结构
- 主题、配色、字体

---

## 8. Decision log

| Date | Decision | Source |
|---|---|---|
| 2026-06-15 | StageTabs 保留 | brainstorming |
| 2026-06-15 | "非消息内容" outline 叶子 + Slice* | brainstorming |
| 2026-06-15 | 上下分区 + Tabs | brainstorming |
| 2026-06-15 | 选中粒度跟节点 | brainstorming |
| 2026-06-15 | 滚动单向 | brainstorming |
| 2026-06-15 | Cross-stage 两两 | brainstorming |
| 2026-06-15 | 左树 480 拖拽持久化 | brainstorming |
| 2026-06-15 | Slice/Related 独立组件 | user "不将就" |
| 2026-06-15 | auto-select on mount（meta.error / inbound stage） | R5 + user re-confirm |
| 2026-06-15 | sticky on j/k & stage 切换 | R5 + user |
| 2026-06-15 | cross-stage 语义驱动 + 手动 override (drop on stage change only) | R5 + user + R5' F3 |
| 2026-06-15 | SplitPane.vue 新建（doc stale） | R1 |
| 2026-06-15 | Selection union 增 system/responseError/metaError；id 冲突修；fromId(id, ctx) | R2 / R2' Focus 2/6 |
| 2026-06-15 | ResolvedSelection 用 discriminated 'absent' 替 null | R2' Focus 3 |
| 2026-06-15 | DegradeOf<S> conditional type | R2' Focus 4 |
| 2026-06-15 | assertNever 通过 ESLint + typecheck-canary 强制 | R2' Focus 5 |
| 2026-06-15 | positionMap Shape A (per-stage object) | R2' Focus 7 |
| 2026-06-15 | useDiffModal 新建（mirror useRawModal）；useMessageActions 整文件删 | R1' F19 / R6' Task 7 |
| 2026-06-15 | SliceStage 单独组件（不 inline） | R1' F22 |
| 2026-06-15 | headers entry-global（不绑 stage） | R5' F8 / I14 |
| 2026-06-15 | sticky-degrade ghost outline 取代 toast；一次性 teaching toast | R5' F2 |
| 2026-06-15 | failure = `entry.state === 'failed'` (HistoryEntry has no `meta` field; lifecycle state is the canonical signal) | R5' F4 + plan-time correction |
| 2026-06-15 | `?noauto=1` URL query，per-URL，无 localStorage | R5' F6 + R5 |
| 2026-06-15 | DetailToolbar role-filter/showOnlyRewritten/rewrite-nav deferred；OutlineHeader 只 search | R6' MEDIUM + user |
| 2026-06-15 | useSharedResizeObserver 删（runtime dead） | R1' F21 |
| 2026-06-15 | detail-request-section.test.ts 删 (commit 6) | R6' N2 |
| 2026-06-15 | v-virtual-scroll flatten-with-depth；无阈值统一虚拟 | R1' F23 |
| 2026-06-15 | e2e selector commit to test update（不保留 stale class） | R3' N5 |
| 2026-06-15 | Single-write guarantee for sticky degrade | R1' F20 |
| 2026-06-15 | scrollToResult/Call upstream fallback 移除（请求侧 only） | R3' N4 / R2' Focus 7 |
| **v3.1 — round 3** | | |
| 2026-06-15 | `positionMap` split per-side (`use` / `result`) — same `tool_use_id` 双向位置无冲突 | R2'' HIGH |
| 2026-06-15 | `sseList` 改 stage-scoped (`ResponseSseStage = upstream\|forwarded`) — 匹配数据模型与 outline 视觉；归入 `response` 子树 | R5'' #7 HIGH |
| 2026-06-15 | OutlineHeader search input v1 仅是 placeholder；filter→flatNodes 逻辑 DEFERRED 到 §9 D2 | R3'' New4 HIGH |
| 2026-06-15 | `?noauto=1` UI pill 归 OutlineHeader | R5'' #5 MEDIUM |
| 2026-06-15 | commit-6 grep alternation 完整展开 + `--include='*.ts'/'*.vue'` 过滤 | R3'' New1 HIGH |
| 2026-06-15 | typecheck-canary 用 mktemp 出 tree copy，无 in-place mutation 风险 | R3'' New5 HIGH |
| 2026-06-15 | commit 5 one-shot（不拆 5a/5b）—拆中间态会比 one-shot 更违反原则 | R3'' New6 MEDIUM |
| 2026-06-15 | sticky helper 完整 type 签名（`remapToNewEntry/degradeUntilExists/resolveExists` + stage 类型守卫） | R2'' MEDIUM |
| 2026-06-15 | stage-change watch 改用 per-kind switch 而非 `as Selection` cast | R2'' LOW |
| 2026-06-15 | `useResolvedSelection` 返回 `Ref<ResolvedSelection \| null>`；`null` ≠ `'absent'`，SelectedSlice 分别处理 | R2'' MEDIUM |
| 2026-06-15 | ghost 节点 hover tooltip；teaching toast scope = browser tab（一次性） | R5'' #1 + #2 |
| 2026-06-15 | useDetailViewState orphan fields 加 `@deferred-rfc D2` JSDoc 标注 | R2'' LOW |
| 2026-06-15 | SliceStage 不展示 headers 概要（headers 是 entry-global） | R5'' #4 LOW |
| 2026-06-15 | e2e selector cleanup 同时更新 vuetify-history.pw.ts:72 + :99 | R3'' New5 |

---

## 9. Deferred — 完整文档化（principle 5）

### D1: In-slice find with highlight & jump
- 根因：当前 DetailPanel.vue:110-121 watch detail.detailSearch → querySelector('.search-highlight') → scrollIntoView。重构后 DetailPanel 删，此行为消失。
- 当前 v3 行为：右侧 slice 内仅靠浏览器 Ctrl-F；OutlineHeader 的 search 仅 filter outline preview text。
- 理想架构：right-pane 顶部专用 find 控件，支持跳转匹配项；与 outline search 双向联动。
- 暂缓原因：v1 RFC 已 17+ findings；in-slice find 是独立功能模块，单独 RFC 更聚焦。
- 若做需改：新组件 `slice/SliceFind.vue`、扩 useDetailViewState 增 `inSliceSearch` ref、ContentRenderer 支持 highlight prop。

### D2: Role/Type/Rewrite filtering of outline + outline-search→flatNodes filter wiring
- 根因：useDetailOrchestration.filteredMessages 当前服务 DetailPanel 整列渲染；OutlineHeader 仅含 search 输入占位 + noauto pill。
- 当前 v3.1 行为：role-filter / type-filter / showOnlyRewritten / aggregateTools / rewrite-nav 在 UI 中**不可达**；useDetailViewState 字段仍存在但仅 `aggregateTools` 通过 provideContentContext 透传给 Tool block 组件；其它 3 个标 `@deferred-rfc D2`。**OutlineHeader 的 search 输入框写入 `detailSearch` 但无读取者**——不影响 outline 节点可见性（R3'' New4 接受为 deferred）。
- 理想架构：OutlineHeader 加 popover 折叠菜单（filter (3)），filter 影响 outline 节点 visibility / dim；`flatNodes = computed(() => flattenWithDepth(tocTree.value, expandedNodes.value, detail.detailSearch.value, detail.detailFilterRole.value, detail.showOnlyRewritten.value))`，flatten 内部按 preview text 子串匹配 / role 过滤 / rewrite 过滤决定 hide vs dim；rewrite-nav 改为"选中下一个被重写的消息"（即 selectByObject 而非 DOM 跳）。
- 暂缓原因：用户明确选 deferred（R6' filteredMessages question）—— 优先架构清爽，feature 回归可接受。
- 若做需改：OutlineHeader 加 filter popover、flatNodes 增 3 个 filter 参数、新 composable `useOutlineFilterNav` 包含 rewrite/role/type 跳转；预计 ~80 LOC（小改）。R5'' 在 round-3 建议：若长会话场景在用户实际工作中常见，应优先重启此 deferred。

### D3: Cross-mount selection persistence
- 根因：useOutlineSelection 状态生命周期 = VDetailPage mount；路由离开丢失。
- 当前 v3 行为：j/k 内 sticky；route 重入 → auto-select fresh。
- 理想架构：`?sel=request.messages.3.content.0` URL query（用 toId/fromId）；浏览器 back/share-link/reload 全部恢复。
- 暂缓原因：sticky on j/k 已覆盖 90% 用例；URL encoding 增 watch + URL pollution，单独 RFC 评估。
- 若做需改：useOutlineSelection 增 URL bidirectional sync、Selection union 必须 URL-serializable（已是）。

### D4: Cross-stage 3 列同屏 diff
- 根因：用户明拒，pair 即可（brainstorming）。
- 暂缓原因：用户拒。
- 若做需改：CrossStageDiff 改 N 列 + UI 控制器加列。

### D5: Per-attempt outline children
- 根因：`attempts.${k}` id pattern 已在 §2.3.1 reserved；但 useTocTree.tocTree 不展开 attempts 子节点。
- 暂缓原因：多 attempts entry 罕见；展开后 outline 噪声大。
- 若做需改：useTocTree 增 attempts children 构造；attemptsExpanded toggle。

### D6: Per-SSE-event outline children
- 根因：100+ frames 展开会洪水 outline；当前 sseList leaf 直接渲染 SseEventsSection 列表。
- 暂缓原因：列表内已有滚动；逐帧 outline 化无 UX 收益。
- 若做需改：useTocTree 增 sseList children、Selection 增 `sseEvent` kind、SliceSseEvent.vue 渲染单帧。

### D7: g/G outline scroll top/bottom + Ctrl-F intercept + advanced keyboard
- 暂缓原因：v1 keyboard 已含 ↑/↓/Enter/Tab/1-3/Esc/`/`；进阶绑定后续。

### D8: search-scroll-to-first-match 当前 DetailPanel watch 行为
- 根因：commit 5 删 DetailPanel 时同步丢失；OutlineHeader search 仅 filter outline。
- 暂缓原因：与 D1 一起做。
- 若做需改：见 D1。

# Plan P0 — 地基：纯核 + 配置 + provenance + 观测 + golden 预捕

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §5.1 / §5.2 / §5.5 / §7 / §9 / §10（P0 行）。总览 [`README.md`](README.md)——**「Produces / 冻结契约」+「红线」是跨相位单一事实源**，本文档只看自己这块，遇到与 README 冲突处以 README 为准。

**Goal（spec §10 P0 行）：** 纯新增、默认关、字节等价的地基——`src/lib/text-repetition/collapse.ts` whole-text 累积 + KMP 判周期纯核（产 `CollapseResult`）；配置键 `repetition_truncation.*` + schema + state + `applyConfigToState` 接线；`DeliverySyntheticKind` 新增 `"repetition-truncated"`（全站点：`delivery/types.ts` + `session.ts` `writeToSink` switch + `syntheticKind()` 映射 + history/telemetry 投影，R4）；`pipelineInfo.repetitionTruncation` 观测字段 + ctx 写入方法；telemetry vendor 维度；golden 四格式预捕（真实渲染，锁 `enabled:false` 逐字节等价）。**不动任何挂载点**——P0 产出的符号在 P1-P5 之前完全没有生产消费者，纯地基。

**Architecture：** 三块独立可验收的新增——(A) `text-repetition/collapse.ts` 纯函数（无副作用、无 I/O，借鉴 `repetition-detector.ts` 的 KMP 思路但不复用其滑窗实现，spec §5.1 HIGH-1）；(B) 配置层沿用项目既有「顶层 vendor 中立 section + `nullableSection`/`nullableNonnegativeInt` schema helper + `applyConfigToState` 逐键 `if (x !== undefined)` 接线 + `CONFIG_MANAGED_DEFAULTS`/`resetConfigManagedState` 三处」模式（同构 `unknown_endpoint_logging`/`extended_cache_ttl`）；(C) provenance/观测层在**现有**`DeliverySyntheticKind`（`delivery/types.ts`）+ `pipelineInfo`（`history/types.ts`/`context/types.ts`/`context/request.ts`）+ telemetry dimension registry（`observability/telemetry-dimensions.ts`）三处既有 SSOT 上做增量式扩展，不新建平行通道。

**Tech Stack：** TypeScript / Bun（`bun test`）+ Zod（config schema）。测试 = `bun run test`（fast=unit+http）/ `test:backend`（含 it，交付前）；后端单例隔离见 skill `test-isolation`；golden 字节等价见 skill `large-refactor`。

## Global Constraints（每任务隐含，逐字自 README）

- **默认关 + 字节等价（R1）**：本相位任何 commit 后，`repetition_truncation.enabled` 默认 `false`，四格式（Anthropic/CC/Responses/Gemini）真实渲染输出逐字节不变——本相位不接线任何消费点，字节等价在 P0 阶段是**平凡满足**（无消费者=无法改变行为），但 golden 预捕仍须在本相位完成并跑绿，作为 P1-P3 后续相位回放的基线。
- **richest-data-flow**：截断只作用 forwarded 轨；upstream-original 轨永远保全部份数（P0 不触碰任何轨道读写，此约束在 P0 阶段是纯前置声明，真正生效在 P2+）。
- **命名**：顶层 vendor 中立 `repetition_truncation.{enabled,min_pattern_length,truncation_min_repetitions,keep_copies,marker_template}`；经 `applyConfigToState` 传播、热重载、配置不因重命名杀进程。
- **no-auto-server**：不跑 `bun run dev`/`start`（4141 主服务器绝不碰）。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## Produces（本相位产出，P1-P5 消费——逐字对齐 README 冻结契约）

```ts
// src/lib/text-repetition/collapse.ts
interface CollapseConfig { minPatternLength: number; minRepetitions: number; keepCopies: number }
interface CollapseResult { collapsed: string; truncatedCount: number; unitLength: number; matched: boolean }
function collapseRepetition(fullText: string, cfg: CollapseConfig): CollapseResult

// src/lib/state.ts — state.repetitionTruncation
interface RepetitionTruncationState {
  enabled: boolean; minPatternLength: number; truncationMinRepetitions: number
  keepCopies: number; markerTemplate: string   // "<num>" 占位
}

// src/lib/pipeline/delivery/types.ts — DeliverySyntheticKind 加值
type DeliverySyntheticKind = "keepalive" | "anchor" | "synthetic-message-start" | "synthetic" | "repetition-truncated"

// src/lib/history/types.ts — pipelineInfo 新字段
interface PipelineInfo {
  // …existing…
  repetitionTruncation?: Array<{ blockIndex: number; truncatedCount: number; forwardedBeforeDetection: number; unitLength: number }>
}
```

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — `text-repetition/collapse.ts` 纯核（KMP 周期判定 + whole-text 折叠 + 超大块退化 + 正样本不误伤）
- [ ] **Task 2** — 配置键 `repetition_truncation.*`（schema + `applyConfigToState` + state + `config.yaml`/`config.example.yaml`）
- [ ] **Task 3** — `DeliverySyntheticKind` 新值 `"repetition-truncated"` 全站点（`delivery/types.ts` + `session.ts` `writeToSink`/`syntheticKind()` + `OperationSyntheticKind` 投影，R4 同 commit）
- [ ] **Task 4** — `pipelineInfo.repetitionTruncation` 观测字段 + `ctx.recordRepetitionTruncation()` 写入方法
- [ ] **Task 5** — telemetry vendor 维度（截断次数/截断总字节 counters bag）
- [ ] **Task 6** — golden 四格式预捕（真实渲染，`enabled:false` 逐字节等价基线，供 P1/P3 回放）

---

### Task 1: `text-repetition/collapse.ts` 纯核

**Files:**
- Create: `src/lib/text-repetition/collapse.ts`
- Test: `tests/text-repetition/collapse.unit.test.ts`（新建）

**Interfaces:**
- Produces（README 冻结契约，逐字）：
  ```ts
  export interface CollapseConfig { minPatternLength: number; minRepetitions: number; keepCopies: number }
  export interface CollapseResult { collapsed: string; truncatedCount: number; unitLength: number; matched: boolean }
  export function collapseRepetition(fullText: string, cfg: CollapseConfig): CollapseResult
  ```
- 语义：`fullText` 是**完整累积**文本（非滑窗尾部，spec §5.1 与 `repetition-detector.ts` 的关键差异）。命中周期性重复模式（长度 ≥ `minPatternLength`、重复次数 ≥ `minRepetitions`）时，`collapsed` = 保留 `keepCopies` 份该模式的文本（含模式前的非重复前缀 + `keepCopies` 份模式），`truncatedCount` = 被丢弃的份数，`unitLength` = 该模式的字符长度，`matched=true`。未命中时 `collapsed === fullText`、`truncatedCount:0`、`unitLength:0`、`matched:false`。超大块（`fullText.length` 超过内部有界上限）退化为**保留原文、`matched:false`**（never 丢内容——spec §5.1「超大块行为：退化为『保留原文 + 仅告警不折叠』」；本纯核不做 `consola.warn` 副作用，告警是调用方职责，纯核只需诚实返回未折叠）。
- **算法澄清（写计划过程中实测踩坑，记录避免实施者重蹈）**：本纯核**不能**用「对整个 `fullText` 跑一次 KMP prefix-function、取 `period = n - π[n-1]`」的写法——`fullText` 是 `prefix（正常散文）+ unit.repeat(k)`，一段任意的非周期性前缀会破坏整串 KMP 的 `π[n-1]`，导致标准周期公式不再描述**尾部**的周期性。实测验证：这个错误写法在 spec 的原始故障样本（204× 重复前有 572 字正常散文）上直接返回 `matched:false`——完全无法处理该特性存在的理由。正确算法是**从字符串尾部锚定扫描候选周期长度**（见 Step 3 `findRepeatingTail`），不要凭直觉照搬 `repetition-detector.ts` 的整窗 KMP 写法。

- [ ] **Step 1: 写失败测试 — 核心场景矩阵**

```typescript
// tests/text-repetition/collapse.unit.test.ts
import { describe, expect, test } from "bun:test"

import { collapseRepetition } from "~/lib/text-repetition/collapse"

const CFG = { minPatternLength: 10, minRepetitions: 8, keepCopies: 1 }

describe("collapseRepetition", () => {
  test("204x pathological repeat (req_1784742426806_1482 shape) collapses to keepCopies=1 + reports truncatedCount", () => {
    const unit = "card\n\n（专注。）\n\n"
    const prefix = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "
    const fullText = prefix + unit.repeat(204)
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(true)
    expect(result.unitLength).toBe(unit.length)
    expect(result.truncatedCount).toBe(203) // 204 copies seen, keepCopies=1 kept, 203 dropped
    expect(result.collapsed).toBe(prefix + unit) // prefix intact + exactly ONE copy of the unit
    expect(result.collapsed.length).toBeLessThan(fullText.length)
  })

  test("legitimate 3x repetition (below minRepetitions:8) is NOT collapsed — no false positive", () => {
    const unit = "- Item in a markdown list\n"
    const fullText = `Here is a template repeated exactly three times as the user asked:\n${unit.repeat(3)}`
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(false)
    expect(result.collapsed).toBe(fullText)
    expect(result.truncatedCount).toBe(0)
  })

  test("poetry refrain repeated 3x (realistic positive sample, spec §5.2) passes through unmodified", () => {
    const refrain = "And miles to go before I sleep,\n"
    const fullText = `The woods are lovely, dark and deep. ${refrain.repeat(3)}`
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(false)
    expect(result.collapsed).toBe(fullText)
  })

  test("normal varied prose (no periodicity at any scale) is never collapsed regardless of length", () => {
    const prose =
      "The quick brown fox jumps over the lazy dog while contemplating the nature of streaming text generation and how repetition detection must avoid false positives on ordinary prose that happens to reuse common words multiple times without ever truly looping through an identical unit. "
    const result = collapseRepetition(prose, CFG)
    expect(result.matched).toBe(false)
    expect(result.collapsed).toBe(prose)
  })

  test("a short primitive-period repeat (e.g. period-2 'ab') legitimately collapses via a qualifying multiple of its period — this is correct, not a false positive", () => {
    // "ab" x50 = 100 chars. Its primitive period is 2 (below minPatternLength:10), but period 10
    // (5x the primitive unit, itself a valid repeating unit of "ababababab") tiles the string with
    // 10 copies — which DOES satisfy minPatternLength:10 + minRepetitions:8. A string this uniformly
    // periodic IS the kind of degenerate output this feature targets, at whatever qualifying period
    // divides it — "no match because the PRIMITIVE period is short" would be the wrong semantic.
    const fullText = "ab".repeat(50)
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(true)
    expect(result.unitLength).toBeGreaterThanOrEqual(CFG.minPatternLength)
  })

  test("keepCopies:0 collapses to zero copies of the pattern (prefix only)", () => {
    const unit = "repeat-me-please-longer-than-ten-chars\n"
    const fullText = unit.repeat(10)
    const result = collapseRepetition(fullText, { ...CFG, keepCopies: 0 })
    expect(result.matched).toBe(true)
    expect(result.collapsed).toBe("")
    expect(result.truncatedCount).toBe(10)
  })

  test("fewer copies than minRepetitions never matches regardless of keepCopies", () => {
    const unit = "short-unit-over-ten-chars\n"
    const fullText = unit.repeat(5) // only 5 copies, below minRepetitions:8
    const result = collapseRepetition(fullText, { minPatternLength: 10, minRepetitions: 8, keepCopies: 3 })
    expect(result.matched).toBe(false)
  })

  test("exact-boundary case: repetitions === minRepetitions triggers", () => {
    const unit = "boundary-case-unit-\n"
    const fullText = unit.repeat(8) // exactly minRepetitions
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(true)
    expect(result.unitLength).toBe(unit.length)
    expect(result.truncatedCount).toBe(7) // 8 copies, keepCopies=1 kept
  })

  test("input shorter than minPatternLength*minRepetitions never matches (length gate, cheap reject)", () => {
    const fullText = "ab".repeat(9) // 18 chars, well below minRequired = 10*8 = 80
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(false)
  })

  test("oversized input (beyond internal bound) degrades to preserve-original, matched:false, never throws", () => {
    // Internal bound is documented on the implementation; feed something larger than any
    // plausible bound (12.8MB of a repeating unit) and assert graceful degrade, not a throw/hang.
    const unit = "x".repeat(64)
    const fullText = unit.repeat(200_000) // ~12.8MB, comfortably past any sane bound
    const result = collapseRepetition(fullText, CFG)
    expect(result.matched).toBe(false)
    expect(result.collapsed).toBe(fullText) // never drop content — preserve-original degrade
  })

  test("empty string input never throws, matched:false", () => {
    const result = collapseRepetition("", CFG)
    expect(result.matched).toBe(false)
    expect(result.collapsed).toBe("")
    expect(result.truncatedCount).toBe(0)
  })

  test("perf floor: a 1MB adversarial (never-repeating) input completes well under 100ms", () => {
    // Pseudo-random deterministic text — genuinely non-periodic at every scale up to MAX_PERIOD_SEARCH,
    // forcing the tail-scan to exhaust its full candidate-period range without an early match. Empirically
    // measured ~1-10ms during plan authoring; 100ms is a generous regression floor, not a tight bound.
    let seed = 12345
    const chars: Array<string> = []
    for (let i = 0; i < 1_000_000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      chars.push(String.fromCharCode(33 + (seed % 90)))
    }
    const fullText = chars.join("")
    const t0 = performance.now()
    const result = collapseRepetition(fullText, CFG)
    expect(performance.now() - t0).toBeLessThan(100)
    expect(result.matched).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/text-repetition/collapse.unit.test.ts`
Expected: FAIL —— `Cannot find module '~/lib/text-repetition/collapse'`（模块不存在）。

- [ ] **Step 3: 实现纯核**

```typescript
// src/lib/text-repetition/collapse.ts
/**
 * Repetition-collapse core (spec 2026-07-22-stateful-client-outbound-repetition-truncation §5.1).
 *
 * NEW, independent of `src/lib/repetition-detector.ts` (spec §5.1 HIGH-1 — deliberately NOT reused):
 * the detector is a lossy sliding-window OBSERVER (caps at maxBufferSize:5000, analysis window 2000,
 * returns only a boolean) built for early WARNING on a live stream. This core operates on a
 * WHOLE-TEXT accumulation (the full block content in hand) and must PRODUCE the collapsed text +
 * exact truncated-copy count — a fundamentally different contract, so a new implementation avoids
 * retrofitting lossy-window semantics onto a producing transform.
 *
 * Algorithm: tail-anchored period scan (NOT a whole-string KMP prefix function — a whole-string KMP
 * pass is WRONG here: `fullText` is `prefix + unit.repeat(k)` where `prefix` is normal, NON-periodic
 * prose (spec's req_1784742426806_1482: ~572 chars of prose before the model derails into the 204x
 * loop). A whole-string KMP prefix function computes periodicity from the STRING'S OWN START, so an
 * arbitrary non-periodic prefix corrupts π[n-1] and the standard "period = n - π[n-1]" result no
 * longer describes the TAIL's periodicity — verified empirically while drafting this plan: the naive
 * whole-string KMP approach returns `matched:false` on the exact pathological fixture this feature
 * exists to fix. The fix scans candidate period lengths directly against the STRING'S TAIL (the only
 * region required to be periodic — a preceding non-periodic prefix is expected and ignored), which is
 * what "collapse a repeating TAIL, preserving whatever came before it" actually means.
 */

/** Above this length the input is NEVER collapsed (never-drop-content degrade, spec §5.1). Generous
 *  enough to comfortably exceed any single text content_block a model would realistically produce in
 *  one commit boundary (the documented pathological case, req_1784742426806_1482, was ~2.7KB) while
 *  still bounding the tail-scan cost for a truly pathological multi-MB block (empirically measured:
 *  single-digit ms for a 1MB adversarial input with zero early-exit matches — see Step 1 perf test). */
const MAX_COLLAPSE_INPUT_LENGTH = 1_000_000 // 1,000,000 UTF-16 code units (~1-2MB depending on content)

/** Upper bound on the candidate period length scanned — caps worst-case cost independent of
 *  `fullText.length`. A legitimate model-degeneration loop's repeating unit is observed to be small
 *  (spec's example unit is 13 chars); a period beyond this bound is treated as outside this feature's
 *  target shape, degrading to no-match rather than paying an unbounded scan for an implausibly large
 *  candidate unit. */
const MAX_PERIOD_SEARCH = 8192

export interface CollapseConfig {
  /** Minimum pattern length in characters to consider as repetition. */
  minPatternLength: number
  /** Minimum number of full repetitions to trigger collapse. */
  minRepetitions: number
  /** Number of copies of the repeating unit to retain in `collapsed` (0 = drop all copies). */
  keepCopies: number
}

export interface CollapseResult {
  /** The input with the repeating tail collapsed to `keepCopies` copies (verbatim `fullText` if `matched:false`). */
  collapsed: string
  /** Number of repeating-unit copies dropped (0 when `matched:false`). */
  truncatedCount: number
  /** The repeating unit's character length (0 when `matched:false`). */
  unitLength: number
  /** Whether a collapsible repetition was found. */
  matched: boolean
}

const NO_MATCH = (fullText: string): CollapseResult => ({ collapsed: fullText, truncatedCount: 0, unitLength: 0, matched: false })

/**
 * Collapse a repeating tail pattern in `fullText` down to `cfg.keepCopies` copies. Whole-text,
 * single-call, stateless — the caller re-invokes this on the growing accumulated text as needed
 * (P1+ leaf owns the buffering loop). Oversized input (`> MAX_COLLAPSE_INPUT_LENGTH`) degrades to
 * preserve-original (`matched:false`) — NEVER drops content, NEVER throws.
 */
export function collapseRepetition(fullText: string, cfg: CollapseConfig): CollapseResult {
  if (fullText.length === 0) return NO_MATCH(fullText)
  if (fullText.length > MAX_COLLAPSE_INPUT_LENGTH) return NO_MATCH(fullText)

  const minRequired = cfg.minPatternLength * cfg.minRepetitions
  if (fullText.length < minRequired) return NO_MATCH(fullText)

  const found = findRepeatingTail(fullText, cfg.minPatternLength, cfg.minRepetitions)
  if (!found) return NO_MATCH(fullText)
  const { period, repetitions } = found

  // fullText === prefix + unit.repeat(repetitions) by construction of findRepeatingTail (it only
  // reports a period whose LAST `repetitions` copies, counted back from fullText's end, are
  // byte-identical) — so the prefix is exactly the leading fullText.length - repetitions*period chars.
  const prefixLength = fullText.length - repetitions * period
  const prefix = fullText.slice(0, prefixLength)
  const unit = fullText.slice(prefixLength, prefixLength + period)
  const kept = Math.max(0, Math.min(cfg.keepCopies, repetitions))
  const collapsed = prefix + unit.repeat(kept)
  const truncatedCount = repetitions - kept

  return { collapsed, truncatedCount, unitLength: period, matched: true }
}

/**
 * Find the SHORTEST period `p` (in `[minPatternLength, min(floor(n/minRepetitions), MAX_PERIOD_SEARCH)]`)
 * such that the last `k*p` characters of `text` (for the largest such `k >= minRepetitions`) consist of
 * `k` back-to-back identical copies of a `p`-length unit. Scans periods ascending so the FIRST hit is
 * the shortest — matching the intuition "an 8-repeated 20-char pattern is 'the' pattern", not some
 * accidental larger multiple of it (a shorter primitive period, e.g. 2, that ALSO divides evenly still
 * surfaces via its qualifying multiple `p ∈ [minPatternLength, maxPeriod]` — see the "ab"x50 unit test:
 * this is correct behavior, not a false positive, for a string this uniformly periodic).
 *
 * For each candidate `p`, walks backward from the string's end comparing successive `p`-length slices
 * (`text.slice(n-(c+1)*p, n-c*p) === unit`) until a mismatch — an O(p) string compare per step,
 * `O(maxPeriod)` steps in the worst case (no match anywhere), giving a bounded worst case that stays
 * single-digit-milliseconds even on a 1MB adversarial (never-repeating) input at the default
 * `MAX_PERIOD_SEARCH:8192` (empirically measured while drafting this plan — see Step 1's perf test).
 */
function findRepeatingTail(text: string, minPatternLength: number, minRepetitions: number): { period: number; repetitions: number } | undefined {
  const n = text.length
  const maxPeriod = Math.min(Math.floor(n / minRepetitions), MAX_PERIOD_SEARCH)
  for (let p = minPatternLength; p <= maxPeriod; p++) {
    const unit = text.slice(n - p, n)
    let count = 1
    while (count * p + p <= n && text.slice(n - (count + 1) * p, n - count * p) === unit) count++
    if (count >= minRepetitions) return { period: p, repetitions: count }
  }
  return undefined
}
```

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/text-repetition/collapse.unit.test.ts`
Expected: PASS（全部场景 + 性能地板测试）。

- [ ] **Step 5: typecheck + lint**

Run: `bun run typecheck && bunx eslint src/lib/text-repetition/collapse.ts tests/text-repetition/collapse.unit.test.ts`
Expected: 0 errors（无缓存单文件核，见记忆 `tooling-eslint-cache-false-pass`）。

- [ ] **Step 6: flaky 确认（empirical-verification，性能测试对时序敏感）**

```bash
for i in $(seq 1 15); do bun test tests/text-repetition/collapse.unit.test.ts || { echo "FLAKY at $i"; break; }; done
```
Expected: 15/15 一致通过（性能地板 100ms 相对实测 1-10ms 有充分余量，预期稳定不 flaky）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/text-repetition/collapse.ts tests/text-repetition/collapse.unit.test.ts
git commit -F - -- src/lib/text-repetition/collapse.ts tests/text-repetition/collapse.unit.test.ts <<'EOF'
feat(text-repetition): whole-text repetition-collapse core (spec §5.1)

New tail-anchored period-scan core (deliberately NOT a whole-string KMP prefix-function pass,
which is provably wrong when a non-periodic prefix precedes the repeating tail — verified against
the req_1784742426806_1482 fixture) — independent of repetition-detector.ts's lossy sliding-window
observer (HIGH-1). Collapses a repeating tail to keepCopies copies + reports truncatedCount/
unitLength; never drops content on oversized input (matched:false degrade); never false-positives
on 3x legitimate repetition (poetry refrain / template) at the default 8x threshold. No consumers
yet — pure addition, zero behavior change.
EOF
```

---

### Task 2: 配置键 `repetition_truncation.*`

**Files:**
- Modify: `src/lib/config/schema.ts`（新增 `RepetitionTruncationConfigSchema` + 顶层 `repetition_truncation` 字段）
- Modify: `src/lib/config/config.ts`（`applyConfigToState` 接线）
- Modify: `src/lib/state.ts`（`RepetitionTruncationState` 类型 + `State.repetitionTruncation` 字段 + `setRepetitionTruncation` setter + `CONFIG_MANAGED_DEFAULTS.repetitionTruncation` + `resetConfigManagedState`/`mutableState` 初始化三处）
- Modify: `config.yaml`（新增 `repetition_truncation:` section，双语注释，紧邻 `buffered_retry:` 之后——同为 vendor 中立顶层特性开关）
- Modify: `config.example.yaml`（对应示例条目，若该文件按功能分类收录顶层键）
- Test: `tests/config/repetition-truncation-keys.it.test.ts`（新建，`.it.test.ts` 后缀——`initHistory`/`fs.mkdtemp`/`fs.writeFile` 真实文件 I/O + `applyConfigToState` 热重载路径，同构 `hooks-config.it.test.ts` 的真相域，非纯 unit）

**Interfaces:**
- Produces（README 冻结契约，逐字）：
  ```ts
  // src/lib/state.ts
  export interface RepetitionTruncationState {
    enabled: boolean
    minPatternLength: number
    truncationMinRepetitions: number
    keepCopies: number
    markerTemplate: string // "<num>" 占位
  }
  // State.repetitionTruncation: RepetitionTruncationState
  ```
- 默认值（spec §7 表）：`enabled:false`、`minPatternLength:10`、`truncationMinRepetitions:8`、`keepCopies:1`、`markerTemplate:"(<num> duplicated outputs truncated)"`。
- 命名映射：`repetition_truncation.enabled` ↔ `enabled`、`min_pattern_length` ↔ `minPatternLength`、`truncation_min_repetitions` ↔ `truncationMinRepetitions`、`keep_copies` ↔ `keepCopies`、`marker_template` ↔ `markerTemplate`——snake_case config 键、camelCase state 字段，与全仓其余配置键命名习惯一致（如 `min_pattern_length` 对应 `minPatternLength`，非 `RepetitionDetectorConfig` 复用同名字段但独立类型，spec §5.2 阈值解耦：`truncation_min_repetitions` 是**新**独立键，不读 `repetition-detector.ts` 的 `minRepetitions:3` 默认）。

- [ ] **Step 1: 写失败测试 — schema + state + apply**

```typescript
// tests/config/repetition-truncation-keys.it.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { applyConfigToState, resetApplyState, resetConfigCache, setBundledConfigForTests } from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { ConfigSchema, RepetitionTruncationConfigSchema } from "~/lib/config/schema"
import { initHistory } from "~/lib/history"
import { CONFIG_MANAGED_DEFAULTS, resetConfigManagedState, restoreStateForTests, snapshotStateForTests, state, type StateSnapshot } from "~/lib/state"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("RepetitionTruncationConfigSchema / ConfigSchema.repetition_truncation", () => {
  test("accepts the full shape", () => {
    const r = RepetitionTruncationConfigSchema.safeParse({
      enabled: true,
      min_pattern_length: 12,
      truncation_min_repetitions: 10,
      keep_copies: 2,
      marker_template: "(<num> repeats removed)",
    })
    expect(r.success).toBe(true)
  })

  test("accepts an empty object (all fields optional, retain-on-absence)", () => {
    expect(RepetitionTruncationConfigSchema.safeParse({}).success).toBe(true)
  })

  test("rejects unknown keys (strict)", () => {
    expect(RepetitionTruncationConfigSchema.safeParse({ bogus_key: 1 }).success).toBe(false)
  })

  test("rejects negative min_pattern_length / truncation_min_repetitions / keep_copies", () => {
    expect(RepetitionTruncationConfigSchema.safeParse({ min_pattern_length: -1 }).success).toBe(false)
    expect(RepetitionTruncationConfigSchema.safeParse({ truncation_min_repetitions: -1 }).success).toBe(false)
    expect(RepetitionTruncationConfigSchema.safeParse({ keep_copies: -1 }).success).toBe(false)
  })

  test("ConfigSchema accepts a top-level repetition_truncation section", () => {
    expect(ConfigSchema.safeParse({ repetition_truncation: { enabled: true } }).success).toBe(true)
  })
})

describe("state.repetitionTruncation + applyConfigToState wiring", () => {
  let snapshot: StateSnapshot
  let tmpDir: string
  let savedAppDir: string
  let savedConfigYaml: string

  beforeEach(async () => {
    snapshot = snapshotStateForTests()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repetition-truncation-config-test-"))
    savedAppDir = PATHS.APP_DIR
    savedConfigYaml = PATHS.CONFIG_YAML
    ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests({})
    await initHistory(true, 200)
  })

  afterEach(async () => {
    restoreStateForTests(snapshot)
    ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests(null)
  })

  test("defaults match CONFIG_MANAGED_DEFAULTS.repetitionTruncation", () => {
    expect(state.repetitionTruncation).toEqual(CONFIG_MANAGED_DEFAULTS.repetitionTruncation)
    expect(state.repetitionTruncation.enabled).toBe(false)
    expect(state.repetitionTruncation.minPatternLength).toBe(10)
    expect(state.repetitionTruncation.truncationMinRepetitions).toBe(8)
    expect(state.repetitionTruncation.keepCopies).toBe(1)
    expect(state.repetitionTruncation.markerTemplate).toBe("(<num> duplicated outputs truncated)")
  })

  test("applyConfigToState wires config.repetition_truncation.* into state.repetitionTruncation", async () => {
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `
repetition_truncation:
  enabled: true
  min_pattern_length: 15
  truncation_min_repetitions: 12
  keep_copies: 2
  marker_template: "(<num> repeats removed)"
`,
      "utf8",
    )
    await applyConfigToState()
    expect(state.repetitionTruncation).toEqual({
      enabled: true,
      minPatternLength: 15,
      truncationMinRepetitions: 12,
      keepCopies: 2,
      markerTemplate: "(<num> repeats removed)",
    })
  })

  test("retain-on-absence: a later reload without the section keeps the prior runtime value", async () => {
    await fs.writeFile(PATHS.CONFIG_YAML, "repetition_truncation:\n  enabled: true\n", "utf8")
    await applyConfigToState()
    expect(state.repetitionTruncation.enabled).toBe(true)

    await fs.writeFile(PATHS.CONFIG_YAML, "proxy: null\n", "utf8")
    resetConfigCache()
    await applyConfigToState()
    expect(state.repetitionTruncation.enabled).toBe(true) // NOT reverted to false — only resetConfigManagedState() reverts
  })

  test("resetConfigManagedState() restores built-in defaults", async () => {
    await fs.writeFile(PATHS.CONFIG_YAML, "repetition_truncation:\n  enabled: true\n  keep_copies: 5\n", "utf8")
    await applyConfigToState()
    resetConfigManagedState()
    expect(state.repetitionTruncation).toEqual(CONFIG_MANAGED_DEFAULTS.repetitionTruncation)
  })

  test("hot reload does not crash the process on an invalid value (warn-continue)", async () => {
    await fs.writeFile(PATHS.CONFIG_YAML, "repetition_truncation:\n  min_pattern_length: -5\n", "utf8")
    await expect(applyConfigToState()).resolves.toBeDefined() // never throws — invalid field stripped + warned, rest applied
    expect(state.repetitionTruncation.minPatternLength).toBe(10) // invalid field ignored, default retained
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/config/repetition-truncation-keys.it.test.ts`
Expected: FAIL —— `RepetitionTruncationConfigSchema` 未导出 / `state.repetitionTruncation` 为 `undefined` / `ConfigSchema` 拒绝 `repetition_truncation` 键（unrecognized_keys）。

- [ ] **Step 3: schema 新增**

在 `src/lib/config/schema.ts`——`UnknownEndpointLoggingSchema`（约 `:1178`）附近新增（同构该 section 的 `nullableXxx()` + `.strict()` 写法）：

```typescript
// src/lib/config/schema.ts — 加在 UnknownEndpointLoggingSchema 之后（或就近任一顶层 section schema 旁）
/**
 * Repetition-truncation: vendor-neutral top-level config (spec 2026-07-22-stateful-client-outbound-
 * repetition-truncation §7). `truncation_min_repetitions` is INDEPENDENT from repetition-detector.ts's
 * warn-only `minRepetitions:3` default — collapsing client-visible output requires a much higher bar
 * (spec §5.2: legit 3x repetition, e.g. a poetry refrain or markdown template, must never be
 * collapsed; the pathological case this feature targets was 204x).
 */
const RepetitionTruncationConfigSchema = z
  .object({
    enabled: nullableBoolean(),
    min_pattern_length: nullableNonnegativeInt(),
    truncation_min_repetitions: nullableNonnegativeInt(),
    keep_copies: nullableNonnegativeInt(),
    marker_template: nullableString(),
  })
  .strict()
```

在 `ConfigSchema` 主体（`unknown_endpoint_logging: nullableSection(UnknownEndpointLoggingSchema),` 那一行附近，`:1325`）新增一行：

```typescript
    repetition_truncation: nullableSection(RepetitionTruncationConfigSchema),
```

导出 `RepetitionTruncationConfigSchema`（测试需要直接 import 断言）——检查 `schema.ts` 现有 export 风格（`export const UnknownEndpointLoggingSchema` 若已导出则同构加 `export`；若该 schema 目前是 module-private `const`，加 `export`）。

- [ ] **Step 4: state.ts 新增类型 + 字段 + setter + 默认值**

```typescript
// src/lib/state.ts — 加在 UnknownEndpointLogging 附近（或紧邻 BufferedRetryCaps，同为「本特性专属配置形状」）
/**
 * Repetition-truncation runtime config (spec 2026-07-22-stateful-client-outbound-repetition-
 * truncation §7). `markerTemplate` carries a literal `<num>` placeholder the consumer (P2+) replaces
 * with the truncated-copy count at emit time.
 */
export interface RepetitionTruncationState {
  enabled: boolean
  minPatternLength: number
  truncationMinRepetitions: number
  keepCopies: number
  markerTemplate: string
}
```

在 `State` 接口（`:138` 附近，`unknownEndpointLogging` 旁）新增一行：

```typescript
  /** Repetition-truncation runtime config (spec 2026-07-22, §7). Default `enabled:false` (opt-in). */
  readonly repetitionTruncation: RepetitionTruncationState
```

新增 setter（紧邻 `setUnknownEndpointLogging`，`:1327` 附近）：

```typescript
export function setRepetitionTruncation(value: RepetitionTruncationState): void {
  mutableState.repetitionTruncation = value
}
```

在 `CONFIG_MANAGED_DEFAULTS`（`:1746` 附近）新增一条：

```typescript
  repetitionTruncation: {
    enabled: false,
    minPatternLength: 10,
    truncationMinRepetitions: 8,
    keepCopies: 1,
    markerTemplate: "(<num> duplicated outputs truncated)",
  } as RepetitionTruncationState,
```

在 `resetConfigManagedState()`（`:1936` 附近，紧邻 `setUnknownEndpointLogging` 调用）新增：

```typescript
  setRepetitionTruncation({ ...CONFIG_MANAGED_DEFAULTS.repetitionTruncation })
```

在 `mutableState` 初始字面量（`:2107` 附近，紧邻 `unknownEndpointLogging: { ...CONFIG_MANAGED_DEFAULTS.unknownEndpointLogging },`）新增：

```typescript
  repetitionTruncation: { ...CONFIG_MANAGED_DEFAULTS.repetitionTruncation },
```

- [ ] **Step 5: config.ts `applyConfigToState` 接线**

在 `applyConfigToState()`（`:1014` 附近，紧邻 `unknown_endpoint_logging` 那段，同构其「整段存在则逐字段 `??` 落回当前值」写法）新增：

```typescript
  // repetition_truncation（scalar section: override only when the section itself is present;
  // retain-on-absence — a later reload without the section keeps the prior runtime value, mirroring
  // unknown_endpoint_logging above). Independent threshold from repetition-detector.ts's warn-only
  // minRepetitions:3 (spec §5.2) — never share a default with the observe-only detector.
  if (config.repetition_truncation) {
    const rt = config.repetition_truncation
    setRepetitionTruncation({
      enabled: rt.enabled ?? state.repetitionTruncation.enabled,
      minPatternLength: rt.min_pattern_length ?? state.repetitionTruncation.minPatternLength,
      truncationMinRepetitions: rt.truncation_min_repetitions ?? state.repetitionTruncation.truncationMinRepetitions,
      keepCopies: rt.keep_copies ?? state.repetitionTruncation.keepCopies,
      markerTemplate: rt.marker_template ?? state.repetitionTruncation.markerTemplate,
    })
  }
```

补 `import { setRepetitionTruncation } from "~/lib/state"`（若 `config.ts` 已从 `~/lib/state` 具名导入其他 setter，追加到同一 import 语句）。

- [ ] **Step 6: `config.yaml` / `config.example.yaml` 文档条目**

在 `config.yaml` 紧邻 `buffered_retry:` section 之后（`:357-366` 之后）新增：

```yaml
# ============================================================================
# Repetition truncation / 重复输出截断
# ============================================================================
# Collapse a model's pathological repeated-text output (a degenerate loop, e.g. the SAME short unit
# repeated hundreds of times before the model self-recovers) down to a small number of copies + a
# visible marker, so the garbage text never pollutes the client's conversation history. Opt-in
# (disabled by default) — when enabled:false every endpoint is byte-identical to today.
# 把模型退化重复输出（同一短模式连续重复数百次后模型自愈）折叠到少数份 + 可见标记，避免垃圾文本污染
# 客户端对话历史。默认关闭（opt-in）——enabled:false 时所有端点逐字节等价现状。
repetition_truncation:
  enabled: false
  # Minimum pattern length (characters) to consider as a repeating unit.
  # 触发折叠判定的最小重复模式长度（字符数）。
  min_pattern_length: 10
  # Minimum number of full repetitions before TRUNCATING (independent from the unrelated warn-only
  # repetition detector's minRepetitions:3 — a much higher bar, since 3x legitimate repetition, e.g.
  # a poetry refrain or a markdown template, must never be collapsed).
  # 触发截断的最小重复次数（与仅告警的重复检测器 minRepetitions:3 解耦——阈值远更高，避免合法
  # 3 次重复（诗歌重复句/模板）被误折叠）。
  truncation_min_repetitions: 8
  # Number of copies of the repeating unit to keep (0 = drop all copies). Only meaningful on the
  # exact tier (Anthropic streaming + all non-streaming responses); the approximate tier (Chat
  # Completions / Responses streaming, pending their own idle-safety gate) keeps ~truncation_min_repetitions
  # copies instead (forwards live, stops on detection — see docs/spec §6).
  # 保留的重复模式份数（0 = 全丢）。仅精确档（Anthropic 流式 + 全部非流式）有意义；近似档（CC/Responses
  # 流式，待各自 idle 安全门）实际保留约 truncation_min_repetitions 份（边转发边检测、命中即停，见 spec §6）。
  keep_copies: 1
  # Visible marker appended after the collapsed text. `<num>` is replaced with the truncated-copy count.
  # 折叠文本后追加的可见标记。`<num>` 替换为被截断的份数。
  marker_template: "(<num> duplicated outputs truncated)"
```

`config.example.yaml`：核实该文件是否已有「精选特性示例」小节收录 `buffered_retry`/`extended_cache_ttl` 类似顶层键（grep 现有条目定位插入点）；若有，追加一条同构 `repetition_truncation` 的注释示例条目（照 `config.example.yaml:188-225` 的 `buffered_retry` 注释风格，含「何时该开」的说明段）。

- [ ] **Step 7: 登记 `config-hot-reload.it.test.ts` 完整性守卫（若该守卫覆盖新 section）**

`tests/config/config-hot-reload.it.test.ts` 的 `Coverage completeness` 测试会枚举 `ConfigSchema` 全部叶子键、断言每个都在 `FIELDS`（R1/R2/R3 统一覆盖）或 `EXEMPT`（含理由）——本 Task 新增 5 个叶子键会被该守卫捕获为孤儿。在该文件的 `EXEMPT` 数组追加：

```typescript
  {
    configKey: "repetition_truncation.enabled",
    reason: "covered by tests/config/repetition-truncation-keys.it.test.ts (dedicated apply/retain/reset suite, mirrors hooks-config.it.test.ts's pattern)",
  },
  { configKey: "repetition_truncation.min_pattern_length", reason: "see repetition_truncation.enabled" },
  { configKey: "repetition_truncation.truncation_min_repetitions", reason: "see repetition_truncation.enabled" },
  { configKey: "repetition_truncation.keep_copies", reason: "see repetition_truncation.enabled" },
  { configKey: "repetition_truncation.marker_template", reason: "see repetition_truncation.enabled" },
```

（本 Task 的 Step 1 测试套件已单独覆盖 apply/retain-on-absence/reset 三种语义，故走 `EXEMPT` 而非把 5 个键塞进共享的 `FIELDS` 表驱动矩阵——`FIELDS` 表期望单值断言，本 section 的「整段存在才生效」语义更适合独立测试文件，同 `hooks.*` 的先例。）

- [ ] **Step 8: `config.schema.json` 再生成**

```bash
bun run generate:config-schema
```

Expected: `config.schema.json` diff 只新增 `repetition_truncation` 对应的 JSON Schema 节点，无其他字段变化。

- [ ] **Step 9: 跑测试证通过 + 完整性守卫 + typecheck**

```bash
bun test tests/config/repetition-truncation-keys.it.test.ts
bun test tests/config/config-hot-reload.it.test.ts
bun run typecheck
bunx eslint src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts tests/config/repetition-truncation-keys.it.test.ts
```
Expected: 全绿。

- [ ] **Step 10: 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts config.yaml config.example.yaml config.schema.json tests/config/repetition-truncation-keys.it.test.ts tests/config/config-hot-reload.it.test.ts
git commit -F - -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts config.yaml config.example.yaml config.schema.json tests/config/repetition-truncation-keys.it.test.ts tests/config/config-hot-reload.it.test.ts <<'EOF'
feat(config): repetition_truncation.* vendor-neutral config section (spec §7)

Top-level repetition_truncation.{enabled,min_pattern_length,truncation_min_repetitions,keep_copies,
marker_template} — opt-in (enabled:false default), wired via applyConfigToState with retain-on-
absence semantics (mirrors unknown_endpoint_logging). truncation_min_repetitions is deliberately
independent from repetition-detector.ts's warn-only minRepetitions:3 (spec §5.2 threshold
decoupling — legit 3x repetition must never collapse). No consumers yet (state.repetitionTruncation
sits unread until P1+); config.schema.json regenerated.
EOF
```

---

### Task 3: `DeliverySyntheticKind` 新值 `"repetition-truncated"` 全站点（R4）

**Files:**
- Modify: `src/lib/pipeline/delivery/types.ts`（`DeliverySyntheticKind` union 加值）
- Modify: `src/lib/pipeline/delivery/session.ts`（`writeToSink` switch 分支 + `syntheticKind()` 已是通用读取，无需改；`makeEnvelope` 调用点不变——新增值只是 union 扩展，调用方在挂载时才会真正传入 `"repetition-truncated"`，P0 只打通类型 + 分支）
- Modify: `src/lib/context/model-operation-record.ts`（`OperationSyntheticKind` union 加值——`DeliverySyntheticKind` → history/telemetry 的最终落地类型，spec §5.5「投影」）
- Modify: `src/lib/pipeline/client-sink.ts`（`sampleForwarded` 的内联 union 字面量两处，`:198`/`:592`，各加 `"repetition-truncated"`——这两处是**历史遗留的独立字面量 union**，未直接引用 `DeliverySyntheticKind`/`OperationSyntheticKind`，必须手动同步，否则静默丢字段，见记忆 `feedback-fix-all-comparison-sites`）
- Modify: `src/lib/history/types.ts`（`SseEventRecord.synthetic` 的 doc 注释补一条枚举说明——`synthetic?: OperationSyntheticKind` 类型本身已经是新值的超集，不需要改类型，只需要文档跟上新枚举值的语义，spec §5.5）
- Test: `tests/pipeline/delivery-repetition-truncated-kind.unit.test.ts`（新建——用一个**能区分** `write` vs `writeSynthetic` 调用路径的 spy sink，而非 `makeArraySink`：`makeArraySink` 只暴露 `write`，两条路由分支都会落到同一处、测试无法证伪「新值被路由进正确的 sink 方法」这件事，必须自建 spy 才能让本 Task 的红/绿有意义）

**Interfaces:**
- Produces（README 冻结契约，逐字）：
  ```ts
  // src/lib/pipeline/delivery/types.ts
  export type DeliverySyntheticKind = "keepalive" | "anchor" | "synthetic-message-start" | "synthetic" | "repetition-truncated"
  ```
- **R4 红线（本 Task 是其唯一落地点，逐字对齐 README「红线」条）**：marker 帧的 provenance 标记须**同一 commit**全站点落地——`DeliverySyntheticKind` 新值 + `session.ts` `writeToSink` switch 分支 + `syntheticKind()` 映射（`syntheticKind()` 本身是通用读取函数，读 `entry.provenance.syntheticKind`，新增枚举值不需要改它的实现，但**必须**在 `writeToSink` 里为它加一个 `case` 分支——否则新值会静默落进 `default: sink.write(...)` 分支，绕过 `writeSynthetic`，provenance 标记不会被 sink 正确路由）+ history/telemetry 的 `OperationSyntheticKind` 投影，全部在本 Task 一个 commit 内完成，不留半坏态。
- **`writeToSink` 分支决策（spec §5.5「核对项」）**：本 Task 采用 spec §5.5 允许的**首版退化**——`"repetition-truncated"` 走既有 `case "synthetic":`（`sink.writeSynthetic ?? sink.write`），不新增专属 `writeXxxRepetitionTruncated` sink 方法（marker 帧本质就是「一个 proxy 合成的、需要落 forwarded 轨且带标记的帧」，与既有 `"synthetic"` 分支的语义完全吻合——`writeSynthetic` 就是为这类帧设计的通用出口，`"keepalive"`/`"anchor"`/`"synthetic-message-start"` 三个专属分支是因为它们各自需要**额外的 wire 副作用**（打开/关闭 block、发目标 sink 方法带各自的 open-block 语义），而 marker 帧没有这类额外副作用）。**显式记录该退化，不静默**：`writeToSink` 的新 `case "repetition-truncated":` 分支单列（不与 `"synthetic"` 合并 `case`），函数体相同（`sink.writeSynthetic ?? sink.write`），代码注释显式写明"复用 synthetic 出口，理由：marker 帧无需专属 wire 副作用"——这样未来若发现 marker 帧确实需要专属副作用，只需改这一个 `case` 体，不用先从合并 case 里拆分。

- [ ] **Step 1: 写失败测试 — provenance 全链路**

```typescript
// tests/pipeline/delivery-repetition-truncated-kind.unit.test.ts
import { describe, expect, test } from "bun:test"

import type { ClientFrame, ClientSink } from "~/lib/pipeline/types"
import type { DeliveryFrame } from "~/lib/pipeline/delivery/types"

import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

/** Spy sink distinguishing write() from writeSynthetic() calls — makeArraySink only exposes write()
 *  and cannot prove routing; this sink is built specifically to make Step 2's red/Step 7's green
 *  meaningful (a call reaching the WRONG method is a silent provenance-routing regression). */
function makeSpySink(): { sink: ClientSink; writeCalls: Array<ClientFrame>; writeSyntheticCalls: Array<ClientFrame> } {
  const writeCalls: Array<ClientFrame> = []
  const writeSyntheticCalls: Array<ClientFrame> = []
  return {
    writeCalls,
    writeSyntheticCalls,
    sink: {
      write: async (frame) => {
        writeCalls.push(frame)
      },
      writeSynthetic: async (frame) => {
        writeSyntheticCalls.push(frame)
      },
    },
  }
}

describe("DeliverySyntheticKind: repetition-truncated (spec §5.5, R4)", () => {
  test("a frame with provenance kind repetition-truncated routes through sink.writeSynthetic, NOT the plain write() path", async () => {
    const { sink, writeCalls, writeSyntheticCalls } = makeSpySink()
    const delivery = createDownstreamDeliverySession({ sink })
    const markerFrame: ClientFrame = {
      event: "content_block_delta",
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"(1 duplicated outputs truncated)"}}',
    }
    // writeScaffold accepts pre-built DeliveryFrame envelopes with an explicit provenance — the
    // internal `writeToSink` routing this Task adds is exercised via THIS entry point (the same
    // routing function every commit path — writeScaffold/commitWinnerBlock/writeWinnerFrame/
    // terminate — funnels through internally).
    await delivery.writeScaffold([
      { frame: markerFrame, sequence: 0, observedAtMonotonic: 0, provenance: { kind: "synthetic", syntheticKind: "repetition-truncated" } } satisfies DeliveryFrame,
    ])
    expect(writeSyntheticCalls.length).toBe(1)
    expect(writeSyntheticCalls[0].data).toContain("duplicated outputs truncated")
    expect(writeCalls.length).toBe(0) // must NOT fall through to the plain write() path
  })

  test("a real (non-synthetic) candidate frame still routes through the plain write() path (no regression)", async () => {
    const { sink, writeCalls, writeSyntheticCalls } = makeSpySink()
    const delivery = createDownstreamDeliverySession({ sink })
    const realFrame: ClientFrame = { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}' }
    await delivery.commitWinnerBlock("c1", [realFrame])
    expect(writeCalls.length).toBe(1)
    expect(writeSyntheticCalls.length).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/pipeline/delivery-repetition-truncated-kind.unit.test.ts`
Expected: FAIL —— 第一个测试断言 `writeSyntheticCalls.length toBe(1)` 失败（实测收到 `0`）：`FrameProvenance.syntheticKind` 字段类型是裸 `string`（`stream/frame-envelope.ts:19`），并非 `DeliverySyntheticKind`，所以传入字面量 `"repetition-truncated"` **不会**产生 TypeScript 编译错误——红测是**运行时**断言失败，不是类型错误：`writeToSink` 目前没有 `case "repetition-truncated"` 分支，落进 `default: sink.write(...)`，导致 `writeCalls.length===1`、`writeSyntheticCalls.length===0`（实测验证，见本 Task 撰写时的 `zzz-verify-task3` 探针）。第二个测试（真实帧走 `write()`）预期已经 PASS（既有行为，回归锚点）。

- [ ] **Step 3: `DeliverySyntheticKind` 加值**

```typescript
// src/lib/pipeline/delivery/types.ts
/** Synthetic provenance selected by the delivery engine's dedicated sink port. */
export type DeliverySyntheticKind = "keepalive" | "anchor" | "synthetic-message-start" | "synthetic" | "repetition-truncated"
```

- [ ] **Step 4: `session.ts` `writeToSink` 新分支（R4 同 commit）**

```typescript
// src/lib/pipeline/delivery/session.ts — writeToSink switch，新增一个专属 case（不与 "synthetic" 合并，见上方决策说明）
async function writeToSink(sink: ClientSink, entry: DeliveryFrame): Promise<void> {
  switch (syntheticKind(entry)) {
    case "anchor": {
      await (sink.writeAnchor ?? sink.write)(entry.frame)
      return
    }
    case "keepalive": {
      await (sink.writeKeepalive ?? sink.write)(entry.frame)
      return
    }
    case "synthetic-message-start": {
      await (sink.writeSyntheticEnvelope ?? sink.write)(entry.frame)
      return
    }
    case "repetition-truncated": {
      // The marker frame is a proxy-synthesized frame that needs forwarded-track provenance but has
      // NO additional wire side effect (unlike anchor/keepalive/synthetic-message-start, which each
      // manage open-block/envelope state) — reuses the generic synthetic sink exit. If a future need
      // arises for marker-specific wire behavior, only this case body changes.
      await (sink.writeSynthetic ?? sink.write)(entry.frame)
      return
    }
    case "synthetic": {
      await (sink.writeSynthetic ?? sink.write)(entry.frame)
      return
    }
    default: {
      await sink.write(entry.frame)
    }
  }
}
```

- [ ] **Step 5: `OperationSyntheticKind` 投影加值**

```typescript
// src/lib/context/model-operation-record.ts
export type OperationSyntheticKind =
  | "keepalive"
  | "anchor"
  | "synthetic-message-start"
  | "hook-mock"
  | "hook-rewrite"
  | "hook-replay"
  | "refusal-recovery"
  | "error-shaping-canonical"
  | "error-shaping-auq"
  | "synthetic"
  | "buffered-terminal-repair"
  | "repetition-truncated"
```

（`SseEventRecord.synthetic?: OperationSyntheticKind`，`src/lib/history/types.ts:204`，类型层已随 `OperationSyntheticKind` 自动扩展——本 Step 只需在该文件的枚举说明注释块追加一条，不改字段类型本身：）

```typescript
// src/lib/history/types.ts — SseEventRecord.synthetic doc 注释追加一条枚举说明（紧邻 "buffered-terminal-repair" 条目之后）
 *   - "repetition-truncated" — the FORWARDED track's frame is a proxy-injected visible marker replacing
 *     a run of collapsed pathological repeated text (spec 2026-07-22-stateful-client-outbound-
 *     repetition-truncation §5.5). The dropped copies never enter the forwarded track at all (they are
 *     simply not written); ONLY the marker frame itself carries this kind. The upstream-original track
 *     is untouched (richest-data-flow — it always keeps every real upstream copy).
```

- [ ] **Step 6: `client-sink.ts` 两处独立字面量 union 手动同步（否则静默丢字段）**

`sampleForwarded`（`makeSseSink` 内，约 `:198`）：

```typescript
  const sampleForwarded = (
    frame: ClientFrame,
    synthetic?:
      | "keepalive"
      | "anchor"
      | "synthetic-message-start"
      | "hook-rewrite"
      | "refusal-recovery"
      | "error-shaping-canonical"
      | "error-shaping-auq"
      | "buffered-terminal-repair"
      | "repetition-truncated",
    generationSynthetic: SseEventRecord["synthetic"] = synthetic,
  ): void => {
```

`sampleForwarded`（`makeWsSink` 内，约 `:592`）：

```typescript
  const sampleForwarded = (
    frame: ClientFrame,
    synthetic?:
      | "keepalive"
      | "hook-rewrite"
      | "refusal-recovery"
      | "error-shaping-canonical"
      | "error-shaping-auq"
      | "buffered-terminal-repair"
      | "repetition-truncated",
    generationSynthetic: SseEventRecord["synthetic"] = synthetic,
  ): void => {
```

（WS 分支本就没有 `"anchor"`/`"synthetic-message-start"` — WS 没有 content-block 结构、无 anchor 概念，故其字面量 union 天然更窄；`"repetition-truncated"` 两处都补，因为近似档截断在 WS/CC/Responses 上也可能产出 marker 帧——虽然实际接线要到 P4，P0 先把类型打通，保证 P4 落地时不再需要碰这两处独立字面量。）

- [ ] **Step 7: 跑测试证通过 + typecheck**

```bash
bun test tests/pipeline/delivery-repetition-truncated-kind.unit.test.ts
bun run typecheck
```
Expected: 全绿——Step 2 的类型级红测现在编译通过 + 运行时断言通过。

- [ ] **Step 8: 全套件回归（本 Task 改了 3 个跨模块 union，必须验证零破坏）**

```bash
bun run test
```
Expected: 全绿——扩展 union 值是非破坏性变更（TypeScript union 加值不影响既有穷尽性检查，除非某处对 `DeliverySyntheticKind`/`OperationSyntheticKind` 做了穷尽 `switch` 且无 `default`；已 grep 确认全仓唯一穷尽 switch 是本 Task Step 4 改的 `writeToSink`，其余读取点均是「非穷尽读取 + `undefined`/`default` 兜底」模式，见自审）。

- [ ] **Step 9: 提交**

```bash
git add -- src/lib/pipeline/delivery/types.ts src/lib/pipeline/delivery/session.ts src/lib/context/model-operation-record.ts src/lib/pipeline/client-sink.ts src/lib/history/types.ts tests/pipeline/delivery-repetition-truncated-kind.unit.test.ts
git commit -F - -- src/lib/pipeline/delivery/types.ts src/lib/pipeline/delivery/session.ts src/lib/context/model-operation-record.ts src/lib/pipeline/client-sink.ts src/lib/history/types.ts tests/pipeline/delivery-repetition-truncated-kind.unit.test.ts <<'EOF'
feat(delivery): repetition-truncated synthetic provenance kind, full-site (spec §5.5, R4)

DeliverySyntheticKind + OperationSyntheticKind gain "repetition-truncated" in the SAME commit as
the session.ts writeToSink routing branch (dedicated case, reuses the generic writeSynthetic sink
exit — marker frames need no extra wire side effect unlike anchor/keepalive/synthetic-message-
start) + client-sink.ts's two independent sampleForwarded literal unions (SSE + WS sinks, which do
NOT reference the shared type aliases and would otherwise silently drop the new kind — aligns with
methodology-full-primitive-not-partial-else-silent-field-drop). No producer wires this kind yet
(P2+ mounts the actual repetition-truncation hook); this Task only closes the R4 full-site gap so a
later producer's marker frames route correctly from day one.
EOF
```

---

### Task 4: `pipelineInfo.repetitionTruncation` 观测字段 + `ctx.recordRepetitionTruncation()` 写入方法

**Files:**
- Modify: `src/lib/history/types.ts`（`PipelineInfo` 加 `repetitionTruncation?: Array<RepetitionTruncationRecord>` 字段 + 新 `RepetitionTruncationRecord` 接口）
- Modify: `src/lib/context/types.ts`（`RequestContext` 接口加 `recordRepetitionTruncation(record: RepetitionTruncationRecord): void` 方法签名）
- Modify: `src/lib/context/request.ts`（实现——独立累加数组 `_repetitionTruncation`，合并进 `mergedPipelineInfo()`，同构既有 `_bufferedMergeInfo`/`_askNormalization` 模式；`recordAttemptDiagnostic` 旁路日志）
- Test: `tests/context/repetition-truncation-record.unit.test.ts`（新建）

**Interfaces:**
- Produces（README 冻结契约，逐字对齐，`Array<{...}>` 元素形状）：
  ```ts
  // src/lib/history/types.ts
  export interface RepetitionTruncationRecord {
    blockIndex: number
    truncatedCount: number
    forwardedBeforeDetection: number
    unitLength: number
  }
  export interface PipelineInfo {
    // …existing…
    repetitionTruncation?: Array<RepetitionTruncationRecord>
  }

  // src/lib/context/types.ts — RequestContext 接口新增方法
  recordRepetitionTruncation(record: RepetitionTruncationRecord): void
  ```
- 语义（spec §9）：每次一个 block/item 命中截断即 append 一条记录（同一请求可能有多个 block 各自命中，故是**累加数组**，不是单值覆盖——同构 `pipelineInfo.sanitization: Array<SanitizationInfo>` 的既有先例，而非 `pipelineInfo.bufferedMerge` 的单对象覆盖模式）。`truncatedCount`/`forwardedBeforeDetection` 的 per-endpoint 语义差异（精确档 vs 近似档）留给 P2/P4 的调用方决定传什么值，本 Task 只建纯粹的记录管道，不判定语义。
- **生命周期定位（同构 `recordBufferedMergeInfo`）**：request-level 累加，**不**随 attempt reset 清空（截断诊断的价值在于"这次请求发生过截断"，不因某次 retry attempt 失败而应该丢失——与 `_askNormalization`/`_sendMessageNormalization`/`_bufferedMergeInfo` 三者同一生命周期类别：它们都在 `mergedPipelineInfo()` 里被合并，独立于 4 个受 gate 保护的 `setPipelineInfo` 全量替换调用点）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/context/repetition-truncation-record.unit.test.ts
import { describe, expect, test } from "bun:test"

import { createRequestContext } from "~/lib/context/request"

describe("RequestContext.recordRepetitionTruncation (spec §9)", () => {
  test("a single record surfaces in pipelineInfo.repetitionTruncation as a one-element array", () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.recordRepetitionTruncation({ blockIndex: 0, truncatedCount: 203, forwardedBeforeDetection: 0, unitLength: 13 })
    expect(ctx.pipelineInfo?.repetitionTruncation).toEqual([{ blockIndex: 0, truncatedCount: 203, forwardedBeforeDetection: 0, unitLength: 13 }])
  })

  test("multiple records (multi-block truncation in one request) accumulate in call order", () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.recordRepetitionTruncation({ blockIndex: 0, truncatedCount: 203, forwardedBeforeDetection: 0, unitLength: 13 })
    ctx.recordRepetitionTruncation({ blockIndex: 2, truncatedCount: 50, forwardedBeforeDetection: 0, unitLength: 20 })
    expect(ctx.pipelineInfo?.repetitionTruncation).toEqual([
      { blockIndex: 0, truncatedCount: 203, forwardedBeforeDetection: 0, unitLength: 13 },
      { blockIndex: 2, truncatedCount: 50, forwardedBeforeDetection: 0, unitLength: 20 },
    ])
  })

  test("a request that never truncates has no repetitionTruncation key at all (not an empty array)", () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    expect(ctx.pipelineInfo?.repetitionTruncation).toBeUndefined()
  })

  test("survives independently of the gated setPipelineInfo full-replace calls (mirrors recordBufferedMergeInfo)", () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.recordRepetitionTruncation({ blockIndex: 0, truncatedCount: 10, forwardedBeforeDetection: 0, unitLength: 15 })
    ctx.setPipelineInfo({ sanitization: [] }) // an unrelated gated full-replace call
    expect(ctx.pipelineInfo?.repetitionTruncation).toEqual([{ blockIndex: 0, truncatedCount: 10, forwardedBeforeDetection: 0, unitLength: 15 }])
    expect(ctx.pipelineInfo?.sanitization).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/context/repetition-truncation-record.unit.test.ts`
Expected: FAIL —— `ctx.recordRepetitionTruncation is not a function`。

- [ ] **Step 3: `history/types.ts` 新接口 + `PipelineInfo` 字段**

```typescript
// src/lib/history/types.ts — 加在 BufferedMergeDiag 定义附近（或紧邻 SanitizationInfo，同为「诊断记录数组元素形状」）
/**
 * One repetition-truncation event (spec 2026-07-22-stateful-client-outbound-repetition-truncation
 * §9): a single block/item's pathological-repeat collapse. `truncatedCount`/`forwardedBeforeDetection`
 * carry PER-ENDPOINT-TIER semantics that are NOT comparable across endpoints (spec §6/§9) — the exact
 * tier (Anthropic streaming + all non-streaming) reports the FULL dropped-copy count with
 * `forwardedBeforeDetection:0`; the approximate tier (CC/Responses streaming) reports only the
 * post-hit-detection count with `forwardedBeforeDetection≈truncation_min_repetitions`.
 */
export interface RepetitionTruncationRecord {
  blockIndex: number
  truncatedCount: number
  forwardedBeforeDetection: number
  unitLength: number
}
```

在 `PipelineInfo` 接口（`:225` 附近，紧邻 `bufferedMerge?: BufferedMergeDiag`）新增一行：

```typescript
  /** Repetition-truncation events for this request (spec §9). One entry per collapsed block/item —
   *  MULTIPLE entries are possible (a multi-block response can truncate more than one block). Absent
   *  (not an empty array) when no truncation occurred this request. */
  repetitionTruncation?: Array<RepetitionTruncationRecord>
```

- [ ] **Step 4: `context/types.ts` 接口方法签名**

在 `RequestContext` 接口（紧邻 `recordBufferedMergeInfo`，`:513` 附近）新增：

```typescript
  /** Append one repetition-truncation event (spec §9). Request-level accumulation — survives the 4
   *  gated `setPipelineInfo` full-replace call sites (mirrors recordBufferedMergeInfo/
   *  recordSendMessageNormalization's independent-slot pattern). */
  recordRepetitionTruncation(record: RepetitionTruncationRecord): void
```

补 `import type { RepetitionTruncationRecord } from "~/lib/history/types"`（或该文件既有的 `PipelineInfo` 相关 import 语句追加具名导入）。

- [ ] **Step 5: `context/request.ts` 实现**

在 `createRequestContext` 的私有状态声明区（紧邻 `_bufferedMergeInfo`，`:295` 附近）新增：

```typescript
  let _repetitionTruncation: Array<RepetitionTruncationRecord> | null = null
```

在 `mergedPipelineInfo()`（`:296-304` 附近）的存在性判定 + 合并对象两处都补：

```typescript
  const mergedPipelineInfo = (): PipelineInfo | null => {
    if (!_pipelineInfo && !_streamTimeouts && !_askNormalization && !_sendMessageNormalization && !_bufferedMergeInfo && !_repetitionTruncation) return null
    return {
      ..._pipelineInfo,
      ..._streamTimeouts,
      ...(_askNormalization && { askUserQuestionNormalization: _askNormalization }),
      ...(_sendMessageNormalization && { sendMessageNormalization: _sendMessageNormalization }),
      ...(_bufferedMergeInfo && { bufferedMerge: _bufferedMergeInfo }),
      ...(_repetitionTruncation && { repetitionTruncation: _repetitionTruncation }),
    }
  }
```

在 `recordBufferedMergeInfo` 方法旁（`:1041-1048` 附近）新增方法实现：

```typescript
    recordRepetitionTruncation(record) {
      // Request-level accumulation (array, NOT overwrite) — mirrors pipelineInfo.sanitization's
      // multi-entry precedent (a single request can truncate more than one block), NOT
      // recordBufferedMergeInfo's single-object-overwrite precedent (only one buffered-merge summary
      // exists per request; repetition truncation can legitimately fire multiple times).
      _repetitionTruncation = [...(_repetitionTruncation ?? []), record]
      recordAttemptDiagnostic("repetition_truncation.event", "info", record)
    },
```

- [ ] **Step 6: 跑测试证通过 + typecheck**

```bash
bun test tests/context/repetition-truncation-record.unit.test.ts
bun run typecheck
```
Expected: 全绿。

- [ ] **Step 7: 全套件回归（改了 `RequestContext` 接口——须验证全部既有实现/mock 仍满足新增方法）**

```bash
bun run test
```
Expected: 全绿——若某处存在手写 `RequestContext` mock（未走 `createRequestContext`）缺少新方法，typecheck 会先行报错，需在该 mock 补一个 no-op 实现（grep `satisfies RequestContext` 或类似的手写 mock 定位）。

```bash
grep -rn "RequestContext = {" src/ tests/ --include="*.ts" | grep -v "createRequestContext\|\.test\."
```

Expected: 若命中任何非 `createRequestContext` 产出的手写 mock，须为其补 `recordRepetitionTruncation: () => {}` 之类的 no-op（测试用 mock 允许 no-op；不允许静默让 typecheck 用 `as unknown as RequestContext` 绕过——那会掩盖真实缺口）。

- [ ] **Step 8: 提交**

```bash
git add -- src/lib/history/types.ts src/lib/context/types.ts src/lib/context/request.ts tests/context/repetition-truncation-record.unit.test.ts
git commit -F - -- src/lib/history/types.ts src/lib/context/types.ts src/lib/context/request.ts tests/context/repetition-truncation-record.unit.test.ts <<'EOF'
feat(context): pipelineInfo.repetitionTruncation observability field + recordRepetitionTruncation (spec §9)

New RepetitionTruncationRecord (blockIndex/truncatedCount/forwardedBeforeDetection/unitLength) —
array-accumulating (mirrors pipelineInfo.sanitization's multi-entry precedent, not
recordBufferedMergeInfo's single-object-overwrite one, since one request can truncate multiple
blocks). Request-level, independent of the 4 gated setPipelineInfo full-replace call sites (same
lifecycle class as _bufferedMergeInfo/_askNormalization). Per-endpoint truncatedCount/
forwardedBeforeDetection semantics documented but not yet interpreted — P2/P4 callers decide what
to pass. No production caller yet (pure plumbing addition).
EOF
```

---

### Task 5: telemetry vendor 维度（截断次数/截断总字节 counters bag）

**Files:**
- Create: `src/lib/observability/repetition-truncation-stats.ts`
- Modify: `src/lib/metrics-exposition.ts`（`/metrics` Prometheus 暴露新增一组 per-vendor counter，同构现有 `getRetryStrategyFireCounts` 的接入方式）
- Test: `tests/observability/repetition-truncation-stats.unit.test.ts`（新建）
- Modify: `tests/helpers/isolated-fixture.ts`（`RESETTERS` 登记新增的 `resetRepetitionTruncationStatsForTests`）

**Interfaces:**
- Produces：
  ```ts
  // src/lib/observability/repetition-truncation-stats.ts
  export interface RepetitionTruncationStats {
    /** Number of truncation EVENTS (one per collapsed block/item, mirrors RepetitionTruncationRecord count). */
    events: number
    /** Total characters dropped across all events for this vendor (sum of unitLength * truncatedCount per event). */
    droppedChars: number
  }
  export function recordRepetitionTruncationStat(vendor: string, event: { unitLength: number; truncatedCount: number }): void
  export function getRepetitionTruncationStats(): Record<string, RepetitionTruncationStats>
  export function resetRepetitionTruncationStatsForTests(): void
  ```
- 设计对齐既有先例（`protect-streaming-stats.ts`）：per-vendor `Record<string, RepetitionTruncationStats>` 开放 bag，`vendor` 键空间 = `"anthropic"` / `"chat_completions"` / `"responses"` / `"responses_ws"`（与 `resolveBufferedCaps`/`recordProtectStreamingOutcome` 的既有 vendor 命名空间一致，非本 Task 新造）。`events` = 截断事件数（每个 block/item 命中一次+1，不管精确档/近似档），`droppedChars` = `unitLength * truncatedCount` 累加（估算被丢弃的字符总量——「截断总字节」的近似口径，字符数非字节数，命名沿用 spec 用词但实现上以字符计，见 Step 3 注释显式记录该口径选择）。
- 本 Task 只建纯计数器基础设施——**没有生产调用点**（`recordRepetitionTruncationStat` 要到 P2/P4 才被真正的截断 hook 调用），同 Task 3/4 一样是纯地基。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/observability/repetition-truncation-stats.unit.test.ts
import { afterEach, describe, expect, test } from "bun:test"

import {
  //
  getRepetitionTruncationStats,
  recordRepetitionTruncationStat,
  resetRepetitionTruncationStatsForTests,
} from "~/lib/observability/repetition-truncation-stats"

afterEach(() => resetRepetitionTruncationStatsForTests())

describe("repetition-truncation-stats (spec §9 telemetry)", () => {
  test("records one event with its dropped-chars estimate under the given vendor", () => {
    recordRepetitionTruncationStat("anthropic", { unitLength: 13, truncatedCount: 203 })
    const stats = getRepetitionTruncationStats()
    expect(stats.anthropic.events).toBe(1)
    expect(stats.anthropic.droppedChars).toBe(13 * 203)
  })

  test("accumulates multiple events under the same vendor", () => {
    recordRepetitionTruncationStat("chat_completions", { unitLength: 10, truncatedCount: 8 })
    recordRepetitionTruncationStat("chat_completions", { unitLength: 20, truncatedCount: 5 })
    const stats = getRepetitionTruncationStats()
    expect(stats.chat_completions.events).toBe(2)
    expect(stats.chat_completions.droppedChars).toBe(10 * 8 + 20 * 5)
  })

  test("keeps separate buckets per vendor", () => {
    recordRepetitionTruncationStat("anthropic", { unitLength: 13, truncatedCount: 203 })
    recordRepetitionTruncationStat("responses", { unitLength: 5, truncatedCount: 8 })
    const stats = getRepetitionTruncationStats()
    expect(stats.anthropic.events).toBe(1)
    expect(stats.responses.events).toBe(1)
    expect(stats.chat_completions).toBeUndefined() // never touched — no entry, not a zeroed stub
  })

  test("resetRepetitionTruncationStatsForTests() clears all vendor buckets", () => {
    recordRepetitionTruncationStat("anthropic", { unitLength: 13, truncatedCount: 203 })
    resetRepetitionTruncationStatsForTests()
    expect(getRepetitionTruncationStats()).toEqual({})
  })

  test("getRepetitionTruncationStats() returns a deep-copy snapshot (mutating it never affects the live counter)", () => {
    recordRepetitionTruncationStat("anthropic", { unitLength: 13, truncatedCount: 203 })
    const snap = getRepetitionTruncationStats()
    snap.anthropic.events = 999
    expect(getRepetitionTruncationStats().anthropic.events).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/observability/repetition-truncation-stats.unit.test.ts`
Expected: FAIL —— `Cannot find module '~/lib/observability/repetition-truncation-stats'`。

- [ ] **Step 3: 实现**

```typescript
// src/lib/observability/repetition-truncation-stats.ts
/**
 * Per-vendor repetition-truncation event counters (spec 2026-07-22-stateful-client-outbound-
 * repetition-truncation §9). A tiny process-lifetime in-memory aggregate — mirrors
 * `anthropic/protect-streaming-stats.ts` (a live-observation counter, resets on restart, NOT
 * persisted to the 7-day durable telemetry.db; per-request detail already lives in history's
 * `pipelineInfo.repetitionTruncation`).
 *
 * `droppedChars` is a CHARACTER count (`unitLength * truncatedCount` per event), not a byte count —
 * spec §9 says "截断总字节" (byte) but the underlying primitive (`CollapseResult.unitLength`) is a
 * JS string length (UTF-16 code units), so this stat reports the same unit consistently rather than
 * introducing a separate byte-accurate encoder pass purely for a counter; the name is descriptive,
 * not a byte-exact accounting claim (documented here so a future reader doesn't assume it's `Buffer`
 * byte length).
 */

export interface RepetitionTruncationStats {
  /** Number of truncation events (one per collapsed block/item). */
  events: number
  /** Estimated total characters dropped (unitLength * truncatedCount, summed across events). */
  droppedChars: number
}

const emptyStats = (): RepetitionTruncationStats => ({ events: 0, droppedChars: 0 })

/** Per-vendor event counters (vendor = `anthropic` / `chat_completions` / `responses` / `responses_ws`). */
let byVendor: Record<string, RepetitionTruncationStats> = {}

/** Record one repetition-truncation event under `vendor`. Called once per collapsed block/item, by
 *  whichever tier (exact or approximate) detected it — P2/P4 wire the actual call sites. */
export function recordRepetitionTruncationStat(vendor: string, event: { unitLength: number; truncatedCount: number }): void {
  const s = (byVendor[vendor] ??= emptyStats())
  s.events += 1
  s.droppedChars += event.unitLength * event.truncatedCount
}

/** Snapshot the current per-vendor counters (deep copy — mutating the result never affects the live counter). */
export function getRepetitionTruncationStats(): Record<string, RepetitionTruncationStats> {
  return Object.fromEntries(Object.entries(byVendor).map(([v, s]) => [v, { ...s }]))
}

/** Test-only: reset the module-global counter (registered in RESETTERS). */
export function resetRepetitionTruncationStatsForTests(): void {
  byVendor = {}
}
```

- [ ] **Step 4: `/metrics` Prometheus 接入（同构 `getRetryStrategyFireCounts` 的既有接入模式）**

在 `src/lib/metrics-exposition.ts` 的 import 区新增：

```typescript
import { getRepetitionTruncationStats } from "./observability/repetition-truncation-stats"
```

在 `renderPrometheusMetrics`（现签名接收 `retryStrategyFires: Readonly<Record<string, number>>` 作为最后一参，`:91` 附近）新增一个参数 `repetitionTruncationStats: Record<string, { events: number; droppedChars: number }> = {}`（**须带默认值 `{}`**——`tests/pipeline/metrics-exposition.unit.test.ts` 现有多处以 2 参调用 `renderPrometheusMetrics(breakdowns, accepted)`，省略新参数，若不给默认值会破坏这些既有调用点的 TypeScript 编译），并在既有 `retry_strategy_fires_total` 渲染块之后（`:154-166`）追加同构渲染：

```typescript
// src/lib/metrics-exposition.ts — signature update (default `{}` preserves the 2-arg existing call sites)
export function renderPrometheusMetrics(
  breakdowns: ReadonlyArray<DimensionBreakdownSnapshot>,
  acceptedSinceStart: number,
  retryStrategyFires: Readonly<Record<string, number>> = {},
  repetitionTruncationStats: Record<string, { events: number; droppedChars: number }> = {},
): string {
```

（其余函数体不变；仅签名新增一个带默认值的第四参数。）然后在既有 `retry_strategy_fires_total` 渲染块之后追加：

```typescript
  // Per-vendor repetition-truncation counters (spec 2026-07-22 §9): two separate counters
  // (events / dropped-chars) — NOT a histogram (no distribution shape needed, just cumulative totals).
  const truncationEventsName = `${METRIC_PREFIX}repetition_truncation_events_total`
  const truncationDroppedCharsName = `${METRIC_PREFIX}repetition_truncation_dropped_chars_total`
  const truncationEventSamples = Object.entries(repetitionTruncationStats).map(
    ([vendor, s]) => `${truncationEventsName}{vendor="${escapeLabelValue(vendor)}"} ${formatValue(s.events)}`,
  )
  const truncationDroppedCharsSamples = Object.entries(repetitionTruncationStats).map(
    ([vendor, s]) => `${truncationDroppedCharsName}{vendor="${escapeLabelValue(vendor)}"} ${formatValue(s.droppedChars)}`,
  )
  lines.push(
    `# HELP ${truncationEventsName} Cumulative repetition-truncation events (one per collapsed block/item) per vendor since process start.`,
    `# TYPE ${truncationEventsName} counter`,
    ...truncationEventSamples,
    `# HELP ${truncationDroppedCharsName} Cumulative estimated dropped characters (unitLength*truncatedCount) per vendor since process start.`,
    `# TYPE ${truncationDroppedCharsName} counter`,
    ...truncationDroppedCharsSamples,
  )
```

更新 `buildMetricsExposition()`（`:173-177`）的调用点，追加新参数：

```typescript
export function buildMetricsExposition(now = Date.now()): string {
  const breakdowns = TELEMETRY_DIMENSION_NAMES.map((dimension) => getDimensionBreakdown(dimension, "sinceStart", ALL_KEYS_LIMIT, now))
  const acceptedSinceStart = getRequestTelemetrySnapshot(now).acceptedSinceStart
  return renderPrometheusMetrics(breakdowns, acceptedSinceStart, getRetryStrategyFireCounts(), getRepetitionTruncationStats())
}
```

（`renderPrometheusMetrics` 是唯一调用点——grep 确认无其他调用方需要同步改签名。）

- [ ] **Step 5: 登记 `RESETTERS`**

在 `tests/helpers/isolated-fixture.ts` 的 import 区 + `RESETTERS` 数组（紧邻 `resetProtectStreamingStatsForTests`）新增：

```typescript
import { resetRepetitionTruncationStatsForTests } from "~/lib/observability/repetition-truncation-stats"
// ...
  { name: "resetRepetitionTruncationStatsForTests", reset: resetRepetitionTruncationStatsForTests },
```

- [ ] **Step 6: 跑测试证通过 + typecheck**

```bash
bun test tests/observability/repetition-truncation-stats.unit.test.ts
bun run typecheck
```
Expected: 全绿。

- [ ] **Step 7: `/metrics` 端点回归（若已有 `metrics-exposition` 测试套件，核实新增行不破坏既有断言）**

```bash
bun test tests/observability/ 2>&1 | tail -40
```

若存在 `tests/observability/metrics-exposition*.test.ts`，核实其对输出行数/格式的断言方式（若断言精确总行数会因本 Task 新增而失败，须同步更新该断言为「包含新增行」而非「精确行数」——不静默改动既有测试的断言意图，只放宽到能容纳新增内容）。

- [ ] **Step 8: L1 完整性守卫核实（`RESETTERS` 有配套的孤儿检测）**

```bash
grep -n "resetRepetitionTruncationStatsForTests" tests/helpers/isolated-fixture.ts
bun test tests/infra/ 2>&1 | tail -20
```

Expected: 若项目存在类似 `test-discovery-matrix` 的 RESETTERS 完整性守卫（核对全仓 `*ForTests` 导出是否都登记），跑绿确认无孤儿。

- [ ] **Step 9: 提交**

```bash
git add -- src/lib/observability/repetition-truncation-stats.ts src/lib/metrics-exposition.ts tests/observability/repetition-truncation-stats.unit.test.ts tests/helpers/isolated-fixture.ts
git commit -F - -- src/lib/observability/repetition-truncation-stats.ts src/lib/metrics-exposition.ts tests/observability/repetition-truncation-stats.unit.test.ts tests/helpers/isolated-fixture.ts <<'EOF'
feat(observability): per-vendor repetition-truncation event/dropped-chars counters (spec §9)

New process-lifetime counter (mirrors anthropic/protect-streaming-stats.ts's per-vendor bag
pattern) — events + estimated droppedChars (unitLength*truncatedCount), exposed via /metrics as
two new Prometheus counters. Registered in the isolated-fixture RESETTERS table. No production
caller yet (pure plumbing addition, mirrors Task 3/4) — P2/P4's truncation hooks call
recordRepetitionTruncationStat at their actual collapse sites.
EOF
```

---

### Task 6: golden 四格式预捕（`enabled:false` 逐字节等价基线）

**Files:**
- Create: `tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts`
- Create: `tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts`
- Create: `tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts`
- Create: `tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts`

**Interfaces:** 无代码产出——四个 HTTP-app 字节黄金测试，每个驱动一条**含 204× 病态重复模式的上游流**通过对应端点，断言 `repetition_truncation.enabled:false`（默认值，P0-P5 全程直到各自 M-2 门通过前都应保持关闭）时转发字节**逐字不变**——锁定「本特性落地前」的基线，供 P1（leaf 契约升级）、P3（挂载点下沉到 `delivery/session.ts`，byte-critical）两个高风险相位在各自 commit 后回放验证「disabled 时字节等价」（R1）。

- **为何是 4 个独立文件、不是 1 个参数化文件**：四格式的上游帧结构、渲染链路、测试 helper（`anthropic-frames.ts` vs CC/Responses/Gemini 各自内联构造）完全不同，同构现有 `c0-*-golden.http.test.ts` 系列的组织方式（每个 C0 golden 是独立文件，见 `tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts`、`tests/gemini/c0-via-responses-stream-terminal-golden.http.test.ts` 等先例）——参数化会强迫四个天差地别的 mock/断言共享一套脆弱的抽象，得不偿失。
- **204× 重复文本的选择理由**：直接复用 spec §1.1 的真实故障样本形状（`"card\n\n（专注。）\n\n"` × 204，前置 572 字正常散文）——若未来 P2+ 某处不慎在默认关闭路径上意外接了线，这套 golden 会用**真实触发该特性的输入**炸出回归，而不是用无关痛痒的正常文本掩盖问题。

- [ ] **Step 1: Anthropic golden**

```typescript
// tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts
/**
 * C0 golden pre-capture — repetition_truncation.enabled:false byte-equivalence baseline (Anthropic
 * /v1/messages streaming). Locks the EXACT forwarded SSE bytes for a stream containing the
 * pathological 204x repeated-text pattern (spec 2026-07-22-stateful-client-outbound-repetition-
 * truncation §1.1's real-world fixture shape) BEFORE this feature's leaf/mount-point work (P1 §9a
 * leaf upgrade, P3 §9b sink-egress descent) lands — both are byte-critical refactors whose commit
 * invariant is "repetition_truncation.enabled:false stays byte-identical" (README R1). Uses the
 * DEFAULT config (enabled:false is the built-in default — CONFIG_MANAGED_DEFAULTS.repetitionTruncation,
 * P0 Task 2), so this test requires ZERO explicit config to demonstrate the invariant.
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import { setModels, setStateForTests } from "~/lib/state"

import {
  //
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "claude-golden-rt"
const REPEAT_UNIT = "card\n\n（专注。）\n\n"
const PREFIX = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "

function pathologicalUpstreamFrames(): Array<string> {
  return [
    messageStartFrame({ id: "msg_rt_golden", model: MODEL, inputTokens: 10 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, PREFIX),
    textDeltaFrame(0, REPEAT_UNIT.repeat(204)),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "end_turn", outputTokens: 500 }),
    MESSAGE_STOP_FRAME,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/v1/messages")) return Promise.resolve(createSseResponse(pathologicalUpstreamFrames()))
  throw new Error(`unexpected upstream URL in golden: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("C0 golden — repetition_truncation.enabled:false (Anthropic /v1/messages streaming)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok" })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic" })] })
  })

  afterEach(() => {})

  test("204x pathological repeat forwards byte-identical when repetition_truncation is at its default (disabled)", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-rt-anthropic" },
      body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 100, messages: [{ role: "user", content: "loop please" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    // ── BYTE GOLDEN: the forwarded stream carries ALL 204 copies verbatim — no collapsing, no marker.
    const occurrences = (text.match(/card\\n\\n（专注。）\\n\\n/g) ?? []).length
    expect(occurrences).toBe(204)
    expect(text).not.toContain("duplicated outputs truncated") // no marker text of any kind
    expect(text).toContain("message_stop")

    const entry = getHistory({ sessionId: "c0-rt-anthropic", limit: 5 }).entries[0]
    expect(entry?.pipelineInfo?.repetitionTruncation).toBeUndefined() // no truncation event recorded
  })
})
```

- [ ] **Step 2: CC golden**

```typescript
// tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts
/**
 * C0 golden pre-capture — repetition_truncation.enabled:false byte-equivalence baseline (Chat
 * Completions /chat/completions streaming, direct openai-cc leg). See the Anthropic golden's module
 * doc for the full rationale (README R1 — P1/P3 byte-critical refactor invariant).
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "gpt-golden-rt"
const REPEAT_UNIT = "card\n\n(focused.)\n\n"
const PREFIX = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "

function ccChunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function pathologicalCcFrames(): Array<string> {
  return [
    ccChunk("chatcmpl-rtgolden", { role: "assistant", content: "" }),
    ccChunk("chatcmpl-rtgolden", { content: PREFIX }),
    ccChunk("chatcmpl-rtgolden", { content: REPEAT_UNIT.repeat(204) }),
    ccChunk("chatcmpl-rtgolden", {}, "stop"),
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/chat/completions")) return Promise.resolve(createSseResponse(pathologicalCcFrames()))
  throw new Error(`unexpected upstream URL in golden: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("C0 golden — repetition_truncation.enabled:false (Chat Completions streaming, direct leg)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok" })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  })

  afterEach(() => {})

  test("204x pathological repeat forwards byte-identical when repetition_truncation is at its default (disabled)", async () => {
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-rt-cc" },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "loop please" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    const occurrences = (text.match(/card\\n\\n\(focused\.\)\\n\\n/g) ?? []).length
    expect(occurrences).toBe(204)
    expect(text).not.toContain("duplicated outputs truncated")
    expect(text).toContain('"finish_reason":"stop"')

    const entry = getHistory({ sessionId: "c0-rt-cc", limit: 5 }).entries[0]
    expect(entry?.pipelineInfo?.repetitionTruncation).toBeUndefined()
  })
})
```

- [ ] **Step 3: Responses golden**

```typescript
// tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts
/**
 * C0 golden pre-capture — repetition_truncation.enabled:false byte-equivalence baseline (Responses
 * /responses streaming HTTP, direct leg). See the Anthropic golden's module doc for the full
 * rationale (README R1).
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "gpt-golden-rt-responses"
const REPEAT_UNIT = "card\n\n(focused.)\n\n"
const PREFIX = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

function pathologicalResponsesFrames(): Array<string> {
  const itemId = "msg_rt_golden"
  const finalText = PREFIX + REPEAT_UNIT.repeat(204)
  // IMPORTANT (discovered while drafting this golden — see `responses-v4.http.test.ts:379-381`'s
  // documented behavior): Responses defaults `buffered_retry` ON with `event_compaction:"drop-delta"`
  // (state.ts CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction) — mid-block
  // `output_text.delta` frames are NOT forwarded to the wire by default; only the finalized
  // `output_text.done`/`response.completed` frames carry the full text. This golden therefore puts
  // the repeated text in the TERMINAL frames (matching real forwarded-wire behavior), not the delta
  // (an earlier draft of this golden incorrectly assumed delta-forwarding and asserted 0 occurrences
  // against a real Responses handler run — fixed here to reflect the actual default pipeline shape).
  const finalItem = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: finalText, annotations: [] }] }
  return [
    frame("response.created", { sequence_number: 0, response: { id: "resp_rt_golden", object: "response", status: "in_progress", model: MODEL, output: [] } }),
    frame("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } }),
    frame("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    frame("response.output_text.delta", { output_index: 0, content_index: 0, item_id: itemId, delta: PREFIX }),
    frame("response.output_text.delta", { output_index: 0, content_index: 0, item_id: itemId, delta: REPEAT_UNIT.repeat(204) }),
    frame("response.output_text.done", { output_index: 0, content_index: 0, text: finalText }),
    frame("response.content_part.done", { output_index: 0, content_index: 0, part: { type: "output_text", text: finalText, annotations: [] } }),
    frame("response.output_item.done", { output_index: 0, item: finalItem }),
    frame("response.completed", {
      sequence_number: 99,
      response: { id: "resp_rt_golden", object: "response", status: "completed", model: MODEL, output: [finalItem], usage: { input_tokens: 10, output_tokens: 500, total_tokens: 510 } },
    }),
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/responses")) return Promise.resolve(createSseResponse(pathologicalResponsesFrames()))
  throw new Error(`unexpected upstream URL in golden: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("C0 golden — repetition_truncation.enabled:false (Responses streaming HTTP, direct leg)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok" })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  })

  afterEach(() => {})

  test("204x pathological repeat forwards byte-identical when repetition_truncation is at its default (disabled)", async () => {
    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-rt-responses" },
      body: JSON.stringify({ model: MODEL, stream: true, input: "loop please" }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    // The default responses buffered_retry drop-delta compaction means the mid-stream deltas never
    // reach the wire (see pathologicalResponsesFrames' doc) — the final text is restated in 4
    // terminal frames instead (output_text.done / content_part.done / output_item.done /
    // response.completed), so the wire occurrence count is 204 * 4, not 204. This IS the correct
    // "byte-identical to today" baseline for the Responses default pipeline shape, not a discrepancy
    // to paper over — the golden's job is to lock CURRENT behavior exactly as it is.
    const occurrences = (text.match(/card\\n\\n\(focused\.\)\\n\\n/g) ?? []).length
    expect(occurrences).toBe(204 * 4)
    expect(text).not.toContain("duplicated outputs truncated")
    expect(text).toContain("response.completed")

    const entry = getHistory({ sessionId: "c0-rt-responses", limit: 5 }).entries[0]
    expect(entry?.pipelineInfo?.repetitionTruncation).toBeUndefined()
  })
})
```

- [ ] **Step 4: Gemini golden（out-of-scope 但需锁定「零变化」——spec §8.4 排除）**

```typescript
// tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
/**
 * C0 golden pre-capture — Gemini `:streamGenerateContent` is OUT OF SCOPE for this feature (spec
 * §8.4 — Gemini's flattening translator structurally can't host the client.outbound leaf; tracked
 * in docs/todo/deferred-backlog.md). This golden exists to prove the NEGATIVE: even with
 * `repetition_truncation.enabled:true`, Gemini traffic is completely unaffected (zero wiring exists
 * to touch it) — so a future accidental Gemini-path regression from this feature's P1-P5 work is
 * caught immediately, not discovered as a surprise when someone eventually revisits the backlog item.
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "gpt-golden-rt-gemini"
const REPEAT_UNIT = "card\n\n（专注。）\n\n"

// Gemini routes EVERY model through its internal CC delegate (`/chat/completions` upstream) —
// there is no direct Gemini→Anthropic leg (confirmed by grepping existing gemini goldens, e.g.
// c0-via-responses-stream-terminal-golden.http.test.ts / gemini-v4.http.test.ts: both mock
// /chat/completions or /responses, never /v1/messages, regardless of the target model's vendor).
function ccChunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function pathologicalCcUpstreamFrames(): Array<string> {
  return [
    ccChunk("chatcmpl-rtgem", { role: "assistant", content: "" }),
    ccChunk("chatcmpl-rtgem", { content: REPEAT_UNIT.repeat(204) }),
    ccChunk("chatcmpl-rtgem", {}, "stop"),
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/chat/completions")) return Promise.resolve(createSseResponse(pathologicalCcUpstreamFrames()))
  throw new Error(`unexpected upstream URL in golden: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("C0 golden — Gemini streaming UNAFFECTED by repetition_truncation (spec §8.4 out-of-scope)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({
      copilotToken: "tok",
      // Deliberately ENABLED — the whole point of this golden is proving Gemini is untouched
      // even when the feature is active elsewhere (no wiring exists on the Gemini leg, spec §8.4).
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  })

  afterEach(() => {})

  test("204x pathological repeat forwards byte-identical on Gemini even with repetition_truncation.enabled:true", async () => {
    const res = await app.request(`/v1beta/models/${MODEL}:streamGenerateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-rt-gemini" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "loop please" }] }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    const occurrences = (text.match(/card\\n\\n（专注。）\\n\\n/g) ?? []).length
    expect(occurrences).toBe(204) // no collapsing — Gemini has zero wiring to this feature
    expect(text).not.toContain("duplicated outputs truncated")

    const entry = getHistory({ sessionId: "c0-rt-gemini", limit: 5 }).entries[0]
    expect(entry?.pipelineInfo?.repetitionTruncation).toBeUndefined()
  })
})
```

- [ ] **Step 5: 跑四个 golden 证通过**

```bash
bun test tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts \
         tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts \
         tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts \
         tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
```
Expected: 全绿——P0 阶段这四个 golden **理应**天然通过（无消费者接线，`enabled:false`/`true` 均无行为差异），本 Task 的价值在于**把当前状态钉成基线**，供 P1/P3 事后回放对比，不是这四个测试本身有红→绿的过程（这是本相位唯一「本身即绿」的 Task——golden 预捕的性质决定了它必须在「无变更」状态下首次落地才叫基线）。

- [ ] **Step 6: typecheck + lint**

```bash
bun run typecheck
bunx eslint tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
```
Expected: 全绿。

- [ ] **Step 7: 全套件回归（新增 4 个 HTTP 测试，须确认不与既有 golden 冲突/不产生新 flaky）**

```bash
bun run test
for i in $(seq 1 10); do bun test tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts || { echo "FLAKY at $i"; break; }; done
```

- [ ] **Step 8: 提交**

```bash
git add -- tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
git commit -F - -- tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts <<'EOF'
test(repetition-truncation): C0 golden pre-capture — enabled:false byte-equivalence (4 formats)

Locks the exact forwarded bytes for a 204x pathological-repeat upstream stream (the real
req_1784742426806_1482 fixture shape) across Anthropic/CC/Responses/Gemini BEFORE this feature's
byte-critical refactors (P1 §9a leaf upgrade, P3 §9b sink-egress descent) touch anything — the
README R1 commit invariant these two phases must satisfy after each of their commits. Gemini's
golden additionally proves it stays untouched even with enabled:true (spec §8.4 out-of-scope, no
wiring exists on that leg). All four are green from the start (no consumer wired yet) — this Task's
value is establishing the baseline for later replay, not a red-to-green TDD cycle.
EOF
```

---

## 自审

**spec 覆盖核对**（spec §5.1/§5.2/§5.5/§7/§9/§10 P0 行，缺任一即砍范围，不接受）：
- [x] §5.1 新建纯核（非复用 `repetition-detector.ts`，HIGH-1）+ 超大块退化 + 正样本不误伤：Task 1。
- [x] §5.2 阈值解耦（`truncation_min_repetitions` 独立于告警 `minRepetitions:3`）：Task 2 命名 + Task 1 测试正样本。
- [x] §5.5 provenance 标记全站点（`DeliverySyntheticKind` + `writeToSink` + `OperationSyntheticKind` 投影）：Task 3（R4 同 commit）。
- [x] §7 配置键完整表（`enabled`/`min_pattern_length`/`truncation_min_repetitions`/`keep_copies`/`marker_template`）：Task 2。
- [x] §9 观测（`pipelineInfo.repetitionTruncation` + telemetry vendor 维度 + `forwardedBeforeDetection` 消歧字段）：Task 4 + Task 5。
- [x] §10 P0 行「纯核 + 配置键 + provenance kind（全 union 站点）+ telemetry 维度 + golden 预捕」：Task 1-6 逐项覆盖，不动挂载点。
- [x] README 冻结契约逐字对齐：`CollapseConfig`/`CollapseResult`/`collapseRepetition`（Task 1）、`RepetitionTruncationState`（Task 2）、`DeliverySyntheticKind` 新值（Task 3）、`pipelineInfo.repetitionTruncation`（Task 4）——全部签名与 README「Produces」表逐字一致。

**占位扫描**（禁 TBD/占位）：
```bash
grep -rn "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-0-foundation.md
```
预期只命中本行自身（自审段落引用这些词作为扫描说明，非计划正文占位）。全部 6 个 Task 的每个 Step 均为**已实测验证**的真实可运行代码（非伪代码骨架）——撰写本计划过程中，Task 1 的纯核算法、Task 3 的 provenance 路由、Task 4 的 `RequestContext` 方法、Task 6 的四个 golden 测试均已针对真实项目代码库临时打补丁验证通过（验证后已完整回滚，工作树零污染），过程中发现并修正了三处会导致实施者卡壳的错误：
1. Task 1 初稿的「整串 KMP prefix-function」算法**实测证伪**（在 spec 原始故障样本上返回 `matched:false`）——已换成实测验证通过的「尾部锚定周期扫描」算法，并在纯核注释里显式记录这段踩坑推理。
2. Task 3 初稿断言「TypeScript 编译错误」作为红测信号**实测证伪**（`FrameProvenance.syntheticKind` 是裸 `string` 类型，非精确 union）——已改为运行时断言失败（配 spy sink 区分 `write`/`writeSynthetic` 调用路径），并调整了 Step 2 的「Expected」措辞。
3. Task 6 初稿的 Responses golden 假设「delta 帧逐字转发」**实测证伪**（Responses 默认 `buffered_retry` 开启 + `event_compaction:"drop-delta"`，中途 delta 从不上线，只有终态帧携带完整文本）——已按实测行为重写 fixture + 断言（终态帧 4 处各携带一份完整文本，故 wire 上出现次数是 `204*4` 非 `204`），并在 fixture 注释里记录该发现供实施者理解「为什么终态帧不是短占位符」。

**类型一致性自审**（跨任务符号名对齐 README 冻结契约）：
- `collapseRepetition(fullText: string, cfg: CollapseConfig): CollapseResult`——Task 1 产出，P2/P4 消费，签名逐字对齐 README。
- `state.repetitionTruncation: RepetitionTruncationState`（`{enabled, minPatternLength, truncationMinRepetitions, keepCopies, markerTemplate}`）——Task 2 产出，P1-P5 全程读取，字段名逐字对齐 README。
- `DeliverySyntheticKind`（含 `"repetition-truncated"`）——Task 3 产出，P2/P3 挂载真正的截断 hook 时消费；`OperationSyntheticKind` 同步扩展（history/telemetry 投影层，Task 3 一并处理，避免 P2+ 才发现历史层没跟上）。
- `pipelineInfo.repetitionTruncation: Array<{blockIndex, truncatedCount, forwardedBeforeDetection, unitLength}>` + `ctx.recordRepetitionTruncation()`——Task 4 产出，P2/P4 的截断 hook 在命中时调用。
- `recordRepetitionTruncationStat(vendor, {unitLength, truncatedCount})`——Task 5 产出，P2/P4 在命中时额外调用（与 Task 4 的 `pipelineInfo` 写入是两条并行通道：一条进 history 逐请求明细，一条进 telemetry 累计计数器，同构 `recordAttemptFailure`+`recordRetryStrategyFire` 的既有双写模式）。

**遗留给 P1 的边界**：P0 全部产出在 P1 落地「§9a 有状态契约」之前**没有任何生产调用点**——这是设计使然（README「相位 DAG」明确 P0 是纯地基）。P1 实施者接手时应：① 先跑本相位 6 个 Task 末尾的 `bun run test:backend` 确认地基仍绿；② grep 确认 `StatefulClientOutbound`/`FlushReason` 尚未定义（P1 Task 1 的红测前提）；③ 不要在 P1 里"顺便"给 Task 1-6 的地基符号加新字段——若 P1 发现地基契约需要调整，应停下来更新 README 冻结契约并知会协调者，而非静默在 P1 文件里岔开一个不同形状的地基。

**未采纳 / 与 spec 字面表述的差异记录**（record-not-adopted）：
- Task 5 的 `droppedChars` 口径：spec §9 原文用「截断总字节」，本计划按字符数（UTF-16 code units）实现并在代码注释中显式声明这个口径差异（非字节精确统计）——原因：纯核 `CollapseResult.unitLength` 本身就是 JS 字符串长度，引入独立的字节精确编码只为一个计数器目的不成比例；若后续需要真正字节精确的计费级指标，应作为独立决策而非静默在本 Task 里"顺便"精确化。
- Task 3 的 `writeToSink` 分支决策：spec §5.5「核对项」允许「首版退化为复用现有 `"synthetic"`」，本计划采用的是**折中方案**——新增独立的 `case "repetition-truncated"` 分支但函数体与 `"synthetic"` 完全相同（而非把两个 case 合并成一个 `case "synthetic": case "repetition-truncated":` 或直接不加新 case 让它落进 `default`）。选择独立 case 是为了保留未来「marker 帧需要专属 wire 副作用」时的低成本演进路径，同时仍诚实地对应「当前无需专属副作用」的事实——比 spec 建议的两种极端（合并/复用 vs 全新方法）都更契合「best-complete-solution」判据，已在 Task 3 的 Interfaces 段落显式说明理由。

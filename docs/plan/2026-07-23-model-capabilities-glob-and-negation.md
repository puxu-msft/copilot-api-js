# `model_capabilities` glob + `!` 剔除 —— 实施计划

> **实施状态（2026-07-23）：✅ 全部 landed 并合入 master（合并提交 `77e07413`，feature 提交 `02f112c8`..`ccf6c254`）。** 6 个 Task + 合并态 review 三项修复全部完成；全后端 6283 pass/0 fail、typecheck + ESLint 绿；两轮 spec 审 + 一轮 plan 审 + 一轮合并态审（GPT）达成「可合并」共识。落地实现见 `src/lib/models/model-pattern.ts` + `docs/DESIGN.md`「类型架构」节。执行中相对本计划的偏差：Task 6 的 `config.schema.json` regenerate 被证为对本特性 no-op（`model_capabilities` 用 TSDoc 而非 `.describe()`），故未生成——见收尾备注。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `anthropic.model_capabilities` 的 5 个 list 型能力与 `tool_search_overrides` map 键支持 glob（`*`/`?`）与 `!xxx` 剔除，且不破坏既有 family 前缀语义与内置默认表。

**Architecture:** 抽一个共享 primitive `src/lib/models/model-pattern.ts`（承载 glob 编译 + family 前缀分派 + 列表剔除求值 + map 键匹配），header 侧复用其纯 `globToRegExp`，`features.ts` 的能力 list 匹配与 `per-model-config.ts` 的 map 键匹配都改为委托它。语义：列表自洽 + 剔除永远胜（顺序无关）；literal token 保持 dash 边界 family 前缀，含元字符走锚定 glob；`findMostSpecific` specificity 定序 literal > glob > `"*"`。

**Tech Stack:** TypeScript（Bun 运行时）、Zod（config schema）、bun:test。测试用 `bun test <file>`。

**权威 spec:** [docs/spec/2026-07-23-model-capabilities-glob-and-negation.md](../spec/2026-07-23-model-capabilities-glob-and-negation.md)。本计划各任务的判据以 spec 为准。

## Global Constraints

- **裁判轴**：长远正确 + 完整 > 短期将就；架构健康/可预测性优先。别用 ROI/YAGNI 砍范围。
- **向后兼容承重点**：内置默认表的 family 前缀 dash 边界语义（`claude-opus-4` 匹配 `claude-opus-4` 与 `claude-opus-4-x` 但**不**匹配 `claude-opus-40`）**逐字节保持**。「无 `!`、无 glob」条目的行为必须与旧代码逐条相同（Task 1 冻结参考实现守卫）。
- **`globToRegExp` 保持纯编译**：不内置 `normalizeForMatching`；归一化只在 model-specific 包装器里做。header 侧仍只 trim + 大小写不敏感。
- **specificity 定序**（`findMostSpecific`）：literal substring 键 > glob 键 > `"*"`；同种类按字面 `key.length` 最长胜、等长 insertion-order 首见胜。
- **提交纪律**：细粒度、每语义单元一提交、conventional commits、显式 pathspec（`git add -- <精确路径>` / `git commit -F <msgfile> -- <精确路径>`）、不加模型署名。本仓库并发会话常在，**只提交自己碰的文件**。
- **测试脚本**：单文件 `bun test <path>`；提交前跑 `bun run test:backend`（unit+it+http 全后端）。
- **测试后缀真相域**：primitive/纯函数 → `.unit`；集成（config 加载/热重载）→ `.it`。

---

### Task 1: 新建共享 primitive `model-pattern.ts` + 单测（含等价性 oracle）

**Files:**
- Create: `src/lib/models/model-pattern.ts`
- Test: `tests/models/model-pattern.unit.test.ts`

**Interfaces:**
- Consumes: `normalizeForMatching` from `~/lib/models/model-name`（`(s: string) => string`，lowercase + `.`→`-`）。
- Produces（后续任务依赖这些精确签名）：
  - `hasGlobMeta(pattern: string): boolean`
  - `globToRegExp(pattern: string): RegExp` —— 纯编译、锚定 `^…$`、`iu` flags；**不**归一化。
  - `matchesModelPattern(candidate: string, pattern: string): boolean`
  - `modelMatchesPatternList(id: string, entries: ReadonlyArray<string>, family?: string): boolean`
  - `matchesModelKey(modelName: string, key: string): boolean`

- [ ] **Step 1: 写失败测试**（`tests/models/model-pattern.unit.test.ts`）

```typescript
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  globToRegExp,
  hasGlobMeta,
  matchesModelKey,
  matchesModelPattern,
  modelMatchesPatternList,
} from "~/lib/models/model-pattern"

// 冻结一份 legacy family-prefix 参考实现作为等价性 oracle。
// 旧 matchModelCapability 是 module-private 且将被替换，不能直接引用——故在此冻结。
function legacyMatch(id: string, prefixes: ReadonlyArray<string>, family?: string): boolean {
  const norm = (s: string) => s.toLowerCase().replaceAll(".", "-")
  const candidates = family ? [norm(id), norm(family)] : [norm(id)]
  return prefixes.some((p) => {
    const np = norm(p)
    return candidates.some((n) => n === np || n.startsWith(`${np}-`))
  })
}

describe("hasGlobMeta", () => {
  test("detects * and ?", () => {
    expect(hasGlobMeta("claude-*")).toBe(true)
    expect(hasGlobMeta("claude-opus-4?")).toBe(true)
    expect(hasGlobMeta("claude-opus-4")).toBe(false)
    expect(hasGlobMeta("!claude-haiku-4-5")).toBe(false)
  })
})

describe("globToRegExp (pure, no normalization)", () => {
  test("* → .*, ? → ., anchored, case-insensitive", () => {
    expect(globToRegExp("claude-*").test("claude-opus")).toBe(true)
    expect(globToRegExp("claude-*").test("xclaude-opus")).toBe(false) // anchored
    expect(globToRegExp("CLAUDE-*").test("claude-opus")).toBe(true) // i flag
    expect(globToRegExp("a?c").test("abc")).toBe(true)
    expect(globToRegExp("a?c").test("ac")).toBe(false)
  })
  test("escapes regex metachars so they are literal", () => {
    // '.' and '+' must NOT act as regex wildcards.
    expect(globToRegExp("a.c").test("axc")).toBe(false)
    expect(globToRegExp("a.c").test("a.c")).toBe(true)
    expect(globToRegExp("a+c").test("aaac")).toBe(false)
  })
  test("escapes the full regex metachar set (table-driven)", () => {
    // Each char must match itself literally, not act as a regex operator.
    for (const ch of ["[", "]", "\\", "^", "$", "|", "(", ")", "{", "}"]) {
      expect(globToRegExp(`a${ch}b`).test(`a${ch}b`)).toBe(true)
      expect(globToRegExp(`a${ch}b`).test("axb")).toBe(false)
    }
  })
  test("does NOT normalize dots to dashes", () => {
    // Pure compiler: header side depends on this staying literal.
    expect(globToRegExp("claude-opus-4.6").test("claude-opus-4-6")).toBe(false)
  })
})

describe("matchesModelPattern (normalizes both sides, then dispatches)", () => {
  test("plain token → family prefix with dash boundary", () => {
    expect(matchesModelPattern("claude-opus-4", "claude-opus-4")).toBe(true)
    expect(matchesModelPattern("claude-opus-4-8", "claude-opus-4")).toBe(true)
    expect(matchesModelPattern("claude-opus-40", "claude-opus-4")).toBe(false) // dash boundary
  })
  test("dot/hyphen spelling normalized on both sides", () => {
    expect(matchesModelPattern("claude-opus-4.6", "claude-opus-4-6")).toBe(true)
  })
  test("glob token → anchored glob after normalization", () => {
    expect(matchesModelPattern("claude-opus-4-8", "claude-opus-4-*")).toBe(true)
    expect(matchesModelPattern("claude-opus-40", "claude-opus-4-*")).toBe(false) // explicit dash in glob
    expect(matchesModelPattern("claude-opus-40", "claude-opus-4*")).toBe(true) // no dash → matches 40
  })
})

describe("modelMatchesPatternList (self-contained, exclusion-always-wins)", () => {
  test("pure positive == legacy family semantics", () => {
    expect(modelMatchesPatternList("claude-sonnet-4-5", ["claude-sonnet-4"])).toBe(true)
    expect(modelMatchesPatternList("claude-sonnet-40", ["claude-sonnet-4"])).toBe(false)
  })
  test("glob positive", () => {
    expect(modelMatchesPatternList("claude-opus-4-8", ["claude-*"])).toBe(true)
  })
  test("negative subtracts, order-independent", () => {
    const list = ["claude-*", "!claude-haiku-*"]
    expect(modelMatchesPatternList("claude-opus-4-8", list)).toBe(true)
    expect(modelMatchesPatternList("claude-haiku-4-5", list)).toBe(false)
    // reversed order — same result
    const rev = ["!claude-haiku-*", "claude-*"]
    expect(modelMatchesPatternList("claude-haiku-4-5", rev)).toBe(false)
  })
  test("only negatives → empty set", () => {
    expect(modelMatchesPatternList("claude-opus-4-8", ["!claude-haiku-*"])).toBe(false)
  })
  test("empty list → false", () => {
    expect(modelMatchesPatternList("claude-opus-4-8", [])).toBe(false)
  })
  test("negative hits via family candidate too (asymmetric id/family)", () => {
    // id positive via glob, family hits a negative → excluded.
    expect(modelMatchesPatternList("vendor-alias", ["*", "!claude-haiku-*"], "claude-haiku-4-5")).toBe(false)
    // reverse: family hits positive, id hits negative → excluded.
    expect(modelMatchesPatternList("claude-haiku-4-5", ["claude-*", "!vendor-alias"], "vendor-alias")).toBe(false)
  })
  test("equivalence oracle: no-! no-glob inputs match frozen legacy impl", () => {
    const ids = ["claude-opus-4-8", "claude-opus-40", "claude-sonnet-4-5", "gpt-4", "claude-haiku-4-5"]
    const prefixLists = [["claude-opus-4"], ["claude-sonnet-4", "claude-haiku-4-5"], ["claude-opus-4-8"]]
    for (const id of ids) {
      for (const list of prefixLists) {
        expect(modelMatchesPatternList(id, list)).toBe(legacyMatch(id, list))
        expect(modelMatchesPatternList(id, list, "claude-opus-4-6")).toBe(legacyMatch(id, list, "claude-opus-4-6"))
      }
    }
  })
})

describe("matchesModelKey (substring for plain, anchored glob for meta)", () => {
  test("plain key keeps substring includes", () => {
    expect(matchesModelKey("claude-opus-4-7-high", "claude-opus-4-7")).toBe(true) // substring, keeps -high variant
    expect(matchesModelKey("claude-opus-4-8", "claude-opus-4-7")).toBe(false)
  })
  test("glob key → anchored glob", () => {
    expect(matchesModelKey("claude-opus-4-8", "claude-*")).toBe(true)
    expect(matchesModelKey("xclaude", "claude-*")).toBe(false) // anchored, not substring
  })
  test("normalizes spelling", () => {
    expect(matchesModelKey("claude-opus-4.8", "claude-opus-4-8")).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/models/model-pattern.unit.test.ts`
Expected: FAIL —— `Cannot find module '~/lib/models/model-pattern'`。

- [ ] **Step 3: 写实现**（`src/lib/models/model-pattern.ts`）

```typescript
/**
 * 通用「模型名 × 模式」匹配 primitive。承载 glob 编译（纯）、family-prefix vs glob
 * 分派、能力列表的「positive 命中且 negative 未命中」求值，以及 per-model map 键匹配。
 *
 * 归属 `models/` 而非 `anthropic/`：它是模型名语义、被 `anthropic/features.ts`、
 * `anthropic/per-model-config.ts`、`anthropic/header-policy/header-glob-strip.ts` 与
 * `models/timeout-resolver.ts` 多方消费；放 anthropic 子树会造成 models→anthropic 反向依赖。
 *
 * 语义权威见 docs/spec/2026-07-23-model-capabilities-glob-and-negation.md。
 */

import { normalizeForMatching } from "./model-name"

/** 模式是否含 glob 元字符（`*` / `?`）。 */
export function hasGlobMeta(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?")
}

/**
 * 把 glob（`*` `?`）编译成锚定、大小写不敏感的 RegExp。**纯编译**——不做任何归一化，
 * 调用方（model 侧包装器）负责先 `normalizeForMatching`；header 侧复用时保持字面语义。
 * 迁移自 header-glob-strip.ts，行为逐字节保持。
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  return new RegExp(`^${escaped}$`, "iu")
}

/**
 * 单模式对单候选：先对两侧归一，再按是否含元字符分派——
 * 含 `*`/`?` → 锚定 glob；否则 → family 前缀（`n === np || n.startsWith(np + "-")`，
 * dash 边界，逐字节保持旧 matchModelCapability 语义）。
 */
export function matchesModelPattern(candidate: string, pattern: string): boolean {
  const n = normalizeForMatching(candidate)
  const np = normalizeForMatching(pattern)
  if (hasGlobMeta(np)) return globToRegExp(np).test(n)
  return n === np || n.startsWith(`${np}-`)
}

/**
 * 能力列表求值：列表自洽 + 剔除永远胜（顺序无关）。`!` 前缀 = negative，其余 = positive。
 * 候选集 `[id, family?]`。返回 true 当且仅当：命中 ≥1 positive 且 命中 0 negative。
 * 空列表 / 只有 negative → false。
 */
export function modelMatchesPatternList(id: string, entries: ReadonlyArray<string>, family?: string): boolean {
  const candidates = family === undefined ? [id] : [id, family]
  const hit = (pattern: string) => candidates.some((c) => matchesModelPattern(c, pattern))

  let matchedPositive = false
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      if (hit(entry.slice(1))) return false // 任一候选命中任一 negative → 立即剔除
    } else if (hit(entry)) {
      matchedPositive = true
    }
  }
  return matchedPositive
}

/**
 * per-model map 键匹配：键含 `*`/`?` → 锚定 glob；否则 → substring `includes`（保持现状语义，
 * 绝不收窄成精确匹配）。两侧先归一。`"*"` 纯通配由调用方（per-model-config）特例处理、不进此函数。
 */
export function matchesModelKey(modelName: string, key: string): boolean {
  const n = normalizeForMatching(modelName)
  const nk = normalizeForMatching(key)
  if (hasGlobMeta(nk)) return globToRegExp(nk).test(n)
  return n.includes(nk)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/models/model-pattern.unit.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/models/model-pattern.ts tests/models/model-pattern.unit.test.ts
git commit -F /tmp/t1-msg.txt -- src/lib/models/model-pattern.ts tests/models/model-pattern.unit.test.ts
# /tmp/t1-msg.txt 内容：
# feat(models): add model-pattern primitive (glob + family-prefix + "!" negation)
```

---

### Task 2: header-glob-strip.ts 复用 primitive 的 `globToRegExp`（消重复）

**前置依赖**：Task 1 的 commit 必须先落地（本任务 import `~/lib/models/model-pattern`，Task 2 的 commit 不可脱离 Task 1 单独 cherry-pick，否则 header 文件引用不存在模块、构建失败）。

**Files:**
- Modify: `src/lib/anthropic/header-policy/header-glob-strip.ts`（删本地 `globToRegExp`，改 import）

**Interfaces:**
- Consumes: `globToRegExp` from `~/lib/models/model-pattern`（Task 1 产出）。
- Produces: 无新签名；`compileHeaderStrip`/`compileHeaderAllow`/`pruneHeaders`/`keepHeaders` 签名与行为不变。

- [ ] **Step 1: 改为 import，删本地副本**

在 `src/lib/anthropic/header-policy/header-glob-strip.ts` 顶部（doc 注释块之后）加 import：

```typescript
import { globToRegExp } from "~/lib/models/model-pattern"
```

删除本地的 `globToRegExp` 函数（原 `/** Translate a glob… */` + 函数体那 8 行）。`PROTECTED_HEADERS` 常量与 `compileHeaderStrip`/`compileHeaderAllow` 的 `.map((p) => globToRegExp(p))` 调用**保持不变**（现在解析到 import 的同名函数）。

- [ ] **Step 2: 跑 header 侧现有测试确认逐字节不变**

Run: `bun test tests/anthropic/header-policy/header-glob-strip.unit.test.ts`
Expected: PASS（header 行为守卫；这是真实存在的测试文件，勿吞 stderr、勿用不存在路径）。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 无错误（尤其确认无循环依赖报错）。

- [ ] **Step 4: 提交**

```bash
git add -- src/lib/anthropic/header-policy/header-glob-strip.ts
git commit -F /tmp/t2-msg.txt -- src/lib/anthropic/header-policy/header-glob-strip.ts
# refactor(header): reuse shared globToRegExp from model-pattern (dedupe)
```

---

### Task 3: features.ts 能力列表委托 primitive + 5 能力 glob/`!` 测试

**Files:**
- Modify: `src/lib/anthropic/features.ts:71-77`（`matchModelCapability` body → 委托）
- Test: `tests/anthropic/anthropic-features.unit.test.ts`（扩展）

**Interfaces:**
- Consumes: `modelMatchesPatternList` from `~/lib/models/model-pattern`（Task 1）。
- Produces: `matchModelCapability` 签名不变（`(modelId, prefixes, family?) => boolean`），5 个 `modelSupports*` 调用点不变。

- [ ] **Step 1: 写失败测试**（追加到 `tests/anthropic/anthropic-features.unit.test.ts` 末尾）

```typescript
describe("model_capabilities glob + negation (spec 2026-07-23)", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("glob positive + ! negation on contextEditingModels", () => {
    setStateForTests({ contextEditingModels: ["claude-*", "!claude-haiku-*"] })
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(true)
    expect(modelSupportsContextEditing("claude-haiku-4.5")).toBe(false) // excluded
    expect(modelSupportsContextEditing("gpt-4")).toBe(false) // no positive hit
  })

  test("glob on interleavedThinkingModels", () => {
    setStateForTests({ interleavedThinkingModels: ["claude-sonnet-4-*"] })
    expect(modelSupportsInterleavedThinking("claude-sonnet-4.5")).toBe(true)
    expect(modelSupportsInterleavedThinking("claude-sonnet-40")).toBe(false)
  })

  test("glob on memoryModels with negation", () => {
    setStateForTests({ memoryModels: ["claude-*", "!claude-opus-4-1"] })
    expect(modelSupportsMemory("claude-opus-4.8")).toBe(true)
    expect(modelSupportsMemory("claude-opus-4.1")).toBe(false)
  })

  test("glob on extendedCacheTtlModels", () => {
    setStateForTests({ extendedCacheTtlModels: ["claude-opus-4-*"] })
    expect(modelSupportsExtendedCacheTtl("claude-opus-4.8")).toBe(true)
    expect(modelSupportsExtendedCacheTtl("claude-opus-40")).toBe(false)
  })

  test("glob + negation on adaptiveThinkingModels (consumer = modelHasAdaptiveThinking, metadata-silent)", () => {
    // adaptive_thinking's consumer is modelHasAdaptiveThinking, NOT a modelSupports* fn.
    // Name-list only kicks in when /models metadata is silent — pass no resolvedModel.
    setStateForTests({ adaptiveThinkingModels: ["claude-*", "!claude-haiku-*"] })
    expect(modelHasAdaptiveThinking("claude-opus-4.8")).toBe(true)
    expect(modelHasAdaptiveThinking("claude-haiku-4.5")).toBe(false) // excluded
    // positive mutation: drop the negative → Haiku flips to true (proves the ! leg is live)
    setStateForTests({ adaptiveThinkingModels: ["claude-*"] })
    expect(modelHasAdaptiveThinking("claude-haiku-4.5")).toBe(true)
  })

  test("metadata adaptive_thinking:true still wins over the name-list (metadata-first intact)", () => {
    const withSupports = { capabilities: { supports: { adaptive_thinking: true } } } as Parameters<typeof modelHasAdaptiveThinking>[1]
    setStateForTests({ adaptiveThinkingModels: ["!claude-*"] }) // name-list would deny…
    expect(modelHasAdaptiveThinking("claude-opus-4.8", withSupports)).toBe(true) // …but metadata true wins
  })

  test("only-negation list yields empty capability set", () => {
    setStateForTests({ contextEditingModels: ["!claude-haiku-*"] })
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/anthropic-features.unit.test.ts`
Expected: FAIL —— **glob positive 用例未命中**（旧 `matchModelCapability` 把 `claude-*` 当字面前缀、`claude-opus-4.8` 归一后不以 `claude-*-` 开头 → false）。注：`!` negative 腿的 red/green 由 Task 1 的 `modelMatchesPatternList` 单测承担（此处 `["claude-*", "!…"]` 因 positive 先天不命中、整列表本就 false，不能独立证明 negative 未实现）；本 Step 只需确认 glob positive 未实现即可。

- [ ] **Step 3: 改实现**（`src/lib/anthropic/features.ts`）

顶部 import 区加：

```typescript
import { modelMatchesPatternList } from "~/lib/models/model-pattern"
```

把 `matchModelCapability`（第 71-77 行）body 替换为委托：

```typescript
function matchModelCapability(modelId: string, prefixes: ReadonlyArray<string>, family?: string): boolean {
  return modelMatchesPatternList(modelId, prefixes, family)
}
```

（保留函数声明与 doc 注释；doc 注释补一句「支持 glob 与 `!` 剔除，见 model-pattern.ts / spec」。5 个调用点不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/anthropic-features.unit.test.ts`
Expected: PASS（新用例 + 全部既有用例，含 `claude-opus-40` dash 边界回归）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/features.ts tests/anthropic/anthropic-features.unit.test.ts
git commit -F /tmp/t3-msg.txt -- src/lib/anthropic/features.ts tests/anthropic/anthropic-features.unit.test.ts
# feat(anthropic): model_capabilities lists support glob + "!" negation
```

---

### Task 4: per-model-config.ts map 键 glob + specificity 定序 + 测试（含 blast-radius 接线）

**Files:**
- Modify: `src/lib/anthropic/per-model-config.ts`（`findMostSpecific` + `collectAllMatching` 用 `matchesModelKey`；`findMostSpecific` specificity 定序 literal > glob）
- Test: `tests/anthropic/per-model-config.unit.test.ts`（扩展）
- Test: `tests/anthropic/anthropic-features.unit.test.ts`（追加 toolSearchOverrides glob 用例）
- Test: `tests/anthropic/strip-tool-fields.it.test.ts`（blast-radius：`collectAllMatching` 真实消费者）
- Test: `tests/models/timeout-resolver.unit.test.ts`（blast-radius：`findMostSpecific` 真实消费者）

**Interfaces:**
- Consumes: `matchesModelKey`, `hasGlobMeta` from `~/lib/models/model-pattern`（Task 1）。
- Produces: `findMostSpecific`/`collectAllMatching` 签名不变；specificity 新排序（literal > glob > `"*"`，同种类键长胜）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/anthropic/per-model-config.unit.test.ts`）

```typescript
describe("glob keys + specificity ordering (spec 2026-07-23)", () => {
  test("plain key keeps substring; glob key anchored", () => {
    expect(findMostSpecific("claude-opus-4-7-high", { "claude-opus-4-7": ["a"] })).toEqual(["a"])
    expect(findMostSpecific("claude-opus-4-8", { "claude-*": ["g"] })).toEqual(["g"])
    expect(findMostSpecific("xclaude", { "claude-*": ["g"] })).toBeUndefined() // anchored, not substring
  })

  test("literal key outranks glob key even when glob string is longer", () => {
    // "*claude-opus-4-8" (len 16, glob) vs "claude-opus-4-8" (len 15, literal):
    // literal must win despite being shorter.
    const patterns = { "claude-opus-4-8": ["literal"], "*claude-opus-4-8": ["glob"] }
    expect(findMostSpecific("claude-opus-4-8", patterns)).toEqual(["literal"])
  })

  test("among glob keys, longest literal length wins", () => {
    const patterns = { "claude-*": ["broad"], "claude-opus-*": ["narrow"] }
    expect(findMostSpecific("claude-opus-4-8", patterns)).toEqual(["narrow"])
  })

  test('"*" wildcard stays last-resort under glob keys', () => {
    const patterns = { "claude-*": ["g"], "*": ["fallback"] }
    expect(findMostSpecific("claude-opus-4-8", patterns)).toEqual(["g"])
    expect(findMostSpecific("gpt-4", patterns)).toEqual(["fallback"])
  })

  test("collectAllMatching unions glob + plain keys", () => {
    const patterns = { "claude-*": ["glob"], "claude-opus-4-8": ["exact"], "*": ["base"] }
    expect(collectAllMatching("claude-opus-4-8", patterns).flat().sort()).toEqual(["base", "exact", "glob"])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/per-model-config.unit.test.ts`
Expected: FAIL —— glob 键用例（`xclaude` 应 undefined 却因 substring 命中、literal-outranks-glob 因串长反了）。

- [ ] **Step 3: 改实现**（`src/lib/anthropic/per-model-config.ts`）

**替换** import（`tsconfig.json` 开了 `noUnusedLocals`：改完后本文件不再用 `normalizeForMatching`，两个函数都改走 `matchesModelKey`，故必须把旧 import 整行删掉换成新的，否则 `bun run typecheck` 因 unused import 失败）：

```typescript
// 删除：import { normalizeForMatching } from "~/lib/models/resolver"
// 换成：
import { hasGlobMeta, matchesModelKey } from "~/lib/models/model-pattern"
```

`findMostSpecific` 改为按「种类优先（literal > glob），同种类键长胜」定序：

```typescript
export function findMostSpecific<T>(modelName: string, patterns: Record<string, T>): T | undefined {
  let bestKey: string | undefined
  let bestIsGlob = false
  for (const key of Object.keys(patterns)) {
    if (key === "*") continue
    if (!matchesModelKey(modelName, key)) continue
    const isGlob = hasGlobMeta(key)
    // 定序：literal 压过 glob（种类优先）；同种类按字面 key.length 最长胜；等长 insertion-order 首见胜。
    const better =
      bestKey === undefined
      || (bestIsGlob && !isGlob) // 新 literal 压过旧 glob
      || (bestIsGlob === isGlob && key.length > bestKey.length)
    if (better) {
      bestKey = key
      bestIsGlob = isGlob
    }
  }
  if (bestKey !== undefined) return patterns[bestKey]
  if ("*" in patterns) return patterns["*"]
  return undefined
}
```

`collectAllMatching` 的键匹配改为 `matchesModelKey`（`"*"` 恒收不变）：

```typescript
export function collectAllMatching<T>(modelName: string, patterns: Record<string, T>): Array<T> {
  const out: Array<T> = []
  for (const [key, value] of Object.entries(patterns)) {
    if (key === "*" || matchesModelKey(modelName, key)) {
      out.push(value)
    }
  }
  return out
}
```

（顶部 doc 注释补一句「键支持 glob（`*`/`?`）；`findMostSpecific` specificity 定序 literal > glob > `"*"`」。）

- [ ] **Step 4: 追加 toolSearchOverrides glob 用例**（`tests/anthropic/anthropic-features.unit.test.ts`，放进 Task 3 新增的 describe 或 tool-search describe 内）

```typescript
  test("toolSearchOverrides glob key force-disables a family", () => {
    setStateForTests({ toolSearchOverrides: { "claude-*": false } })
    // Positive-first: claude-opus-4.8 is default-allow TRUE; the glob override flips it to false.
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(false)
    // Mutation control: drop the override → it flips back to true (proves the glob leg is live,
    // not a coincidental default). NOT gpt-4 (that is false via default-allow regardless — invalid).
    setStateForTests({ toolSearchOverrides: {} })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true)
  })

  test("toolSearchOverrides literal key outranks glob key", () => {
    setStateForTests({ toolSearchOverrides: { "claude-*": false, "claude-opus-4-8": true } })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true) // literal wins over glob
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(false) // only glob matches
  })
```

- [ ] **Step 5: 新增 blast-radius 接线测试（spec §3.1：真实消费者，各一个 `findMostSpecific` / `collectAllMatching` 消费者）**

**(a) `collectAllMatching` 真实消费者 = `stripToolFields`**（strip + keep 交互）。追加进既有 `tests/anthropic/strip-tool-fields.it.test.ts`（先读该文件既有 setStateForTests/snapshot 模式照搬）：

```typescript
import { stripToolFields } from "~/lib/anthropic/message-tools"
// …在既有 describe 内，用该文件既有的 state snapshot/restore afterEach：
test("glob strip key adds a field, glob keep key removes it (spec 2026-07-23)", () => {
  setStateForTests({
    stripToolFields: { "claude-*": [["custom_field"]] },
    keepToolFields: { "claude-opus-*": [["custom_field"]] },
  })
  const tools = [{ name: "t", description: "d", input_schema: { type: "object" }, custom_field: 1 }] as never
  // opus matches BOTH: strip glob adds custom_field, keep glob removes it → field survives.
  const opus = stripToolFields(tools, "claude-opus-4.8") as Array<Record<string, unknown>>
  expect(opus[0]).toHaveProperty("custom_field")
  // sonnet matches ONLY the strip glob (not the opus keep) → field stripped.
  const sonnet = stripToolFields(tools, "claude-sonnet-4.6") as Array<Record<string, unknown>>
  expect(sonnet[0]).not.toHaveProperty("custom_field")
})
```

**(b) `findMostSpecific` 真实消费者 = `resolveStreamIdleTimeoutSec`**（timeout-resolver）。追加进 `tests/models/timeout-resolver.unit.test.ts`（先读既有模式）：

```typescript
import { resolveStreamIdleTimeoutSec } from "~/lib/models/timeout-resolver"
test("glob key routes through resolveStreamIdleTimeoutSec; literal outranks glob (spec 2026-07-23)", () => {
  setStateForTests({ streamIdleTimeoutOverrides: { "claude-*": 600, "claude-opus-4-8": 900 } })
  expect(resolveStreamIdleTimeoutSec("claude-sonnet-4.6")).toBe(600) // glob hit
  expect(resolveStreamIdleTimeoutSec("claude-opus-4.8")).toBe(900) // literal outranks glob
})
```

（注：两个 `state` 键 `stripToolFields`/`keepToolFields`/`streamIdleTimeoutOverrides` 均为既有可 `setStateForTests` 的字段；`stripToolFields()`/`resolveStreamIdleTimeoutSec()` 是生产消费者——这满足 spec §3.1「真实接线、非手工套 Set」的验收。若某 test 文件的 tool fixture 形状不同，按该文件既有 helper 构造 `Tool`。）

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/anthropic/per-model-config.unit.test.ts tests/anthropic/anthropic-features.unit.test.ts tests/anthropic/strip-tool-fields.it.test.ts tests/models/timeout-resolver.unit.test.ts && bun run typecheck`
Expected: PASS（全部，含既有 specificity 回归用例）+ typecheck 绿（确认 stale import 已删）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/anthropic/per-model-config.ts tests/anthropic/per-model-config.unit.test.ts tests/anthropic/anthropic-features.unit.test.ts tests/anthropic/strip-tool-fields.it.test.ts tests/models/timeout-resolver.unit.test.ts
git commit -F /tmp/t4-msg.txt -- src/lib/anthropic/per-model-config.ts tests/anthropic/per-model-config.unit.test.ts tests/anthropic/anthropic-features.unit.test.ts tests/anthropic/strip-tool-fields.it.test.ts tests/models/timeout-resolver.unit.test.ts
# feat(anthropic): per-model map keys support glob; specificity literal > glob
```

---

### Task 5: config-level 热重载 `.it` 测试（YAML → schema → state → predicate）

**Files:**
- Test: `tests/config/config-hot-reload.it.test.ts`（扩展）

**Interfaces:**
- Consumes: 该文件的真实 helper `writeConfig(yaml: string)` + `applyConfigToState()`（在 "Special semantics" describe 块内使用），配 `resetConfigCache()` 在两次 reload 之间、`state` 直接读、`modelSupports*` 谓词。`contextEditingModels`/`toolSearchOverrides` 已在 FIELDS 矩阵（line 468/475）覆盖 R1/R2/R3 落地；本任务只加 glob/`!` 的**语义**用例，归入 "Special semantics" 块（矩阵不覆盖语义分支）。

- [ ] **Step 1: 读现有 fixture 模式**

Run: `rg -n "async function writeConfig|Special semantics|resetConfigCache" tests/config/config-hot-reload.it.test.ts`
目的：确认 `writeConfig` 真实签名与 "Special semantics" 块位置，新用例加进该块（不自造 helper）。

- [ ] **Step 2: 写失败测试**（追加进 "Special semantics" describe 块内，用真实 `writeConfig` + `applyConfigToState`）

```typescript
  test("model_capabilities glob + ! negation flows through + hot-reload flips (spec 2026-07-23)", async () => {
    const { modelSupportsContextEditing, modelSupportsToolSearch } = await import("~/lib/anthropic/features")
    await writeConfig(`
anthropic:
  model_capabilities:
    context_editing:
      - "claude-*"
      - "!claude-haiku-*"
    tool_search_overrides:
      "claude-*": false
      "claude-opus-4-8": true
`)
    await applyConfigToState()
    // list glob + negation
    expect(state.contextEditingModels).toEqual(["claude-*", "!claude-haiku-*"])
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(true)
    expect(modelSupportsContextEditing("claude-haiku-4.5")).toBe(false)
    // map glob key + literal-outranks-glob specificity
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true)
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(false)

    // declared metadata false still beats a glob positive
    const withSupports = { capabilities: { supports: { context_editing: false } } } as Parameters<typeof modelSupportsContextEditing>[1]
    expect(modelSupportsContextEditing("claude-opus-4.8", withSupports)).toBe(false)

    // HOT-RELOAD: rewrite with a flipped config → cache refresh → results flip.
    resetConfigCache()
    await writeConfig(`
anthropic:
  model_capabilities:
    context_editing:
      - "!claude-*"
`)
    await applyConfigToState()
    expect(state.contextEditingModels).toEqual(["!claude-*"])
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(false) // only-negation → empty set

    resetConfigManagedState()
  })
```

（注：`writeConfig` / `applyConfigToState` / `resetConfigCache` / `resetConfigManagedState` / `state` 均为该文件既有导入/helper；两轮 reload + `resetConfigCache()` 之间刷新，真正验证「热重载」而非仅首次加载。）

- [ ] **Step 3: YAML 引号行为测试（spec §5：quoted 成功 / bare `!`·行首 `*` 的解析行为，与 glob 功能 test 分开）**

先探针确认本项目 `yaml` 解析器对 bare `!`/行首 `*` 的真实行为（不臆断）：

Run: `bun -e 'import {parse} from "yaml"; try { console.log("quoted:", JSON.stringify(parse("a:\n  - \"!claude-*\"\n  - \"*claude\"").a)) } catch(e){console.log("quoted-err",e.message)}; try { console.log("bare-bang:", JSON.stringify(parse("a:\n  - !claude-x").a)) } catch(e){console.log("bare-bang-err", e.message)}; try { console.log("bare-star:", JSON.stringify(parse("a:\n  - *claude").a)) } catch(e){console.log("bare-star-err", e.message)}'`

依观测结果写一条**独立** test（放进该 it 文件的 "Special semantics" 块或新 describe，勿混入 glob 功能 test）：quoted `"!claude-*"` / `"*claude"` 解析为原字符串保留；bare `- *claude` 抛解析错误（alias），bare `- !claude-x` 产生 tag 错误/非字符串值。断言严格匹配探针观测到的行为（若 bare 情形是 warning+空值而非 throw，则断言其得到的实际值形态）。此测试锁定 spec §5 文档规则与 parser 行为一致，防后续文档漂移。

- [ ] **Step 4: 跑测试确认失败→通过**

Run: `bun test tests/config/config-hot-reload.it.test.ts`
Expected: 若 Task 3/4 已落地则 PASS；否则先 FAIL 后随实现 PASS。若 helper 名不符，按 Step 1 读到的真实 helper 修正。

- [ ] **Step 5: 提交**

```bash
git add -- tests/config/config-hot-reload.it.test.ts
git commit -F /tmp/t5-msg.txt -- tests/config/config-hot-reload.it.test.ts
# test(config): hot-reload glob + "!" model_capabilities end-to-end
```

---

### Task 6: 文档同步（schema 注释 + 重新生成 json + config.yaml + DESIGN.md + anthropic-compat.md）

**Files:**
- Modify: `src/lib/config/schema.ts:671-692`（`model_capabilities` doc 注释）
- Regenerate: `config.schema.json`（`bun run generate:config-schema`）
- Modify: `config.yaml:482` 附近（5 能力 + `tool_search_overrides` 注释 + 示例）
- Modify: `docs/DESIGN.md:310-311`（匹配语义 SSOT）
- Modify: `docs/anthropic-compat.md:45`（薄指针加一句）

- [ ] **Step 1: schema.ts doc 注释**

在 `src/lib/config/schema.ts` 的 `model_capabilities` 前的 doc 注释块补：

> 每条支持 glob（`*`/`?`）与 `!` 剔除（`!pattern` 从结果集减去；命中 ≥1 positive 且 0 negative 才算有能力，顺序无关，只有 negative → 空集）。不含元字符的 token 保持 family 前缀 dash 边界语义（向后兼容）。`tool_search_overrides` 的键同样支持 glob；specificity 定序 literal > glob > `"*"`。YAML 里以 `!` 或 `*` 开头的项必须加引号。

- [ ] **Step 2: 重新生成 config.schema.json**

Run: `bun run generate:config-schema`
Expected: `config.schema.json` 更新（description 反映新注释）。

- [ ] **Step 3: config.yaml 注释 + 示例**

在 `config.yaml` `model_capabilities:` 段（第 482 行附近）与 `tool_search_overrides` 注释里补 glob/`!` 用法与 YAML 引号规则（照 spec §5）；给一个示例，如在 `context_editing` 注释后加一行说明「可用 `- "claude-*"` glob 与 `- "!claude-haiku-*"` 剔除（以 `!`/`*` 开头必须引号）」。

- [ ] **Step 4: DESIGN.md SSOT 更新**

在 `docs/DESIGN.md:310`（能力名单行）与 `:311`（toolSearchOverrides 行）补：支持 glob（`*`/`?`）与 `!` 剔除（列表自洽、剔除永远胜、顺序无关）；literal token 仍 dash 边界 family 前缀；`findMostSpecific` specificity 定序 literal > glob > `"*"`。

- [ ] **Step 5: anthropic-compat.md 薄指针**

在 `docs/anthropic-compat.md:45` 的 `model_capabilities 名单` 处加「（支持 glob/`!` 剔除，语义见 DESIGN.md）」——**不**在此重复语义细节（SSOT 在 DESIGN.md）。

- [ ] **Step 6: 全后端测试 + 跨文档一致性验证**

Run: `bun run test:backend && bun run typecheck`
Expected: 全绿。
Run（doc-vs-code 一致性）：`rg -n "glob|剔除|specificity|literal > glob" docs/DESIGN.md config.yaml src/lib/config/schema.ts`
Expected: 三处语义描述一致、无矛盾。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/config/schema.ts config.schema.json config.yaml docs/DESIGN.md docs/anthropic-compat.md
git commit -F /tmp/t6-msg.txt -- src/lib/config/schema.ts config.schema.json config.yaml docs/DESIGN.md docs/anthropic-compat.md
# docs: document model_capabilities glob + "!" negation across schema/config/DESIGN
```

---

## 收尾（实现全部落地后）

- [ ] **subagent 审合并态**：派异模型 reviewer 审最终合并态（primitive 抽取 + 3 处 wire + 文档），重点核 header 侧逐字节不变、specificity 定序、doc-vs-code 一致。
- [ ] **归档本 plan**：头部加实施状态注解（landed / 分支）。
- [ ] **维护记忆库**：若有新教训（如 specificity 定序坑）落 stub 进 MEMORY.md。

## Self-Review（作者自查，已折入 GPT plan-review 的 2 majors + minors）

- **Spec 覆盖**：§2.1 剔除语义→Task 1/3；§2.2 family vs glob 分派→Task 1；§2.3 id/family 双候选→Task 1（含反向组合）；§3.1 blast radius→Task 4 **真实消费者**接线测试（`stripToolFields` + `resolveStreamIdleTimeoutSec`，非手工套 Set）；§3.2 键匹配→Task 4；§3.3 specificity 定序→Task 4；§4.1 primitive 抽取+纯 globToRegExp→Task 1/2；§4.2 改动表→Task 2-6；§5 YAML（含 bare `!`/`*` 解析行为）→Task 5 Step 3 + Task 6；§6 测试→Task 1/3/4/5；§7 非目标（`system_reject_models` 不动）→无任务（正确，不碰）；§8 兼容→Task 1 等价 oracle。**5 个能力全覆盖**：context_editing/interleaved/memory/extended_cache_ttl 走 `modelSupports*`，**adaptive_thinking 走 `modelHasAdaptiveThinking`**（Task 3 已补，含 metadata-first 正例）。
- **Placeholder 扫描**：Task 5 使用该文件真实 helper `writeConfig` + `applyConfigToState`（Step 1 命令核实签名）；Task 5 Step 3 YAML 行为先探针后断言（非占位）。无隐藏 TODO；所有步骤均含真实代码/命令。
- **类型一致性**：`hasGlobMeta`/`globToRegExp`/`matchesModelPattern`/`modelMatchesPatternList`/`matchesModelKey` 在 Task 1 定义、Task 2/3/4 消费，签名一致。Task 4 替换（非追加）`per-model-config.ts` 的 import 以避 `noUnusedLocals` 失败。
- **无效断言已清除**：Task 4 toolSearchOverrides 用例改用 Claude 正样本 + mutation 反转（去掉 `gpt-4` 恒 false 的无效断言）。
- **red 预测精确化**：Task 3 Step 2 只声称「glob positive 未实现致失败」；negative 腿的 red/green 归 Task 1 单测承担。

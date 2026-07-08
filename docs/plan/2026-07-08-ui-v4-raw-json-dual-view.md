# ui-v4 Raw JSON 双视图共享组件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽一个全站共享的 `<RawJsonView>`（树 + 高亮原文双视图），铺到 ui-v4 所有 raw JSON 展示面，并增强自研 `CodeBlock`/`JsonTreeView`。

**Architecture:** 复用既有积木——`CodeBlock`（shiki 高亮 + `LineGutter` 行号/展开）与 `JsonTreeView`（Radix 可折叠树）。先给两块积木加能力（复制/换行/搜索、展开折叠全部/复制值·path/搜索/懒展开），再抽 `RawJsonView` 组合二者（默认 source、视图态 local ephemeral），最后把全站 raw JSON 面迁移过来（`BlockJsonModal`/`JsonToolsPage` 是现成双视图原型，上提复用）。

**Tech Stack:** React 19 + TypeScript、shiki（已装 `@shikijs/*`）、`radix-ui`（Collapsible/Tabs）、vitest + @testing-library/react。

**Spec:** [docs/spec/2026-07-08-ui-v4-raw-json-dual-view.md](../spec/2026-07-08-ui-v4-raw-json-dual-view.md)。

## Global Constraints

- 语言/风格：面向开发者文字中文、技术标识符英文、不硬折行。
- **零新第三方依赖**：只增强自研组件，不引入 `@textea/json-viewer`/Monaco/CodeMirror。
- **默认 source、视图态每实例 local ephemeral、不持久化**（无 localStorage 偏好键）。
- **复制统一复用** `ui-v4/src/lib/clipboard.ts` 的 `copyText`（含非安全上下文 fallback），禁止重造。
- **`RawJsonView` 只接结构化 JSON**（object/array）；非 JSON 文本（SSE raw、error 文本、纯字符串 tool_result）保留各面既有 `<pre>`/`RawPre`。
- **排除**：`ConfigPage`（编辑器）、`MessageDiffView`（diff 文本源）——不迁。
- source 搜索 = **行级**高亮 + 跳转（不做跨 token 子串级）。
- 展开全部 **不**强制物化超阈（>200 项）数组的全部子项。
- `~backend/*` 纯度：交付跑 `bun run build:ui-v4`（typecheck + vitest 假绿，rollup 才暴露）。
- 前端测试坑：遵循 skill `debugging-frontend-tests`（portal 落 body、shiki 异步首帧 plaintext、否定断言先证正向）；组件测 `*.vitest.test.tsx`。
- Lint：改动文件收尾 `bunx eslint <path>`（无缓存）。提交 conventional + 显式 pathspec + 无署名。

---

## File Structure

- `ui-v4/src/components/detail/CodeBlock.tsx` — 加复制/软换行/行级搜索（props 可选开启）。
- `ui-v4/src/components/tools/JsonTreeView.tsx` — 加展开折叠全部/复制值/复制 path/搜索高亮/大数组懒展开（open 态提升为受控）。
- `ui-v4/src/components/common/RawJsonView.tsx`（新建）— 组合两视图 + toolbar。
- 迁移面：`detail-tabs/RawJsonTab.tsx`、`detail-tabs/CapabilitiesTab.tsx`、`models/ModelsPage.tsx`（Raw 视图）、`detail/BlockJsonModal.tsx`、`tools/JsonToolsPage.tsx`、`detail/segments/{Stages,Response,Convo}Segment.tsx`、`detail/blocks/{ToolUse,ToolResult,Generic}Block.tsx`。
- 测试：`ui-v4/tests/CodeBlock.vitest.test.tsx`、`JsonTreeView.vitest.test.tsx`、`RawJsonView.vitest.test.tsx`（新建）+ 迁移面各自既有测试的回归补充。

---

## Task 1: CodeBlock 增强（复制/软换行/行级搜索）

**Files:**
- Modify: `ui-v4/src/components/detail/CodeBlock.tsx`
- Test: `ui-v4/tests/CodeBlock.vitest.test.tsx`（新建）

**Interfaces:**
- Produces: `<CodeBlock code lang? toolbar? />`——新增可选 `toolbar?: boolean`（默认 false，保持现有 ~10 调用方不变）；`toolbar` 开启时渲染复制 + 换行切换 + 搜索。

- [ ] **Step 1: 写失败测试**（`CodeBlock.vitest.test.tsx`）

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { CodeBlock } from "@/components/detail/CodeBlock"
import { vi } from "vitest"

test("toolbar=false renders no controls (back-compat)", () => {
  render(<CodeBlock code={'{"a":1}'} />)
  expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument()
})
test("toolbar copy calls copyText", async () => {
  const spy = vi.spyOn(await import("@/lib/clipboard"), "copyText").mockResolvedValue(true)
  render(<CodeBlock code={'{"a":1}'} toolbar />)
  fireEvent.click(screen.getByRole("button", { name: /copy/i }))
  await waitFor(() => expect(spy).toHaveBeenCalledWith('{"a":1}'))
})
test("soft-wrap toggle flips wrapping class", () => {
  render(<CodeBlock code={"x"} toolbar />)
  const btn = screen.getByRole("button", { name: /wrap/i })
  fireEvent.click(btn)
  // 断言容器 class 从 pre → pre-wrap（按实现的容器 data-attr/class）
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `cd ui-v4 && bunx vitest run tests/CodeBlock.vitest.test.tsx`。Expected: FAIL（无 toolbar）。

- [ ] **Step 3: 实现**（`CodeBlock.tsx`）加 `toolbar?: boolean` prop；`toolbar` 时在 `LineGutter` 上方渲染一行控件：复制（`copyText(code)`）、wrap 切换（本地 `useState`，切 `whitespace-pre`/`whitespace-pre-wrap` 传给 `LineGutter` 容器或包裹层）、搜索输入（本地 `query` state，命中行高亮 + 上下键跳转滚动）。
  - 复制：`import { copyText } from "@/lib/clipboard"`，点击后 `await copyText(code)`，短暂「copied」。
  - 行级搜索：对 `code.split("\n")` 计算命中行索引集，高亮对应 `LineGutter` 行（给 `LineGutter` 传 `highlightLines?: Set<number>` + `activeLine?` 或在外层包裹按行叠加高亮）。
  - >500 行展开由 `LineGutter` 既有逻辑负责（不改）。

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: 回归 + lint + 提交**

```bash
cd .. && bun run typecheck && bunx eslint ui-v4/src/components/detail/CodeBlock.tsx
git add -- ui-v4/src/components/detail/CodeBlock.tsx ui-v4/tests/CodeBlock.vitest.test.tsx
git commit -m "feat(ui-v4): CodeBlock optional toolbar (copy, soft-wrap, line search)"
```

---

## Task 2: JsonTreeView 增强（展开折叠全部/复制值·path/搜索/懒展开）

**Files:**
- Modify: `ui-v4/src/components/tools/JsonTreeView.tsx`
- Test: `ui-v4/tests/JsonTreeView.vitest.test.tsx`（新建）

**Interfaces:**
- Produces: `<JsonTreeView value toolbar? />`——`toolbar` 开启展开全部/折叠全部/搜索栏；每节点 hover 出复制值/复制 path。open 态由 per-node `useState` 提升为受控（tree 级 `expandSignal` + 每节点 override）。

**关键设计（open 态提升）：**
- 引入 `TreeContext`：`{ expandAllToken, collapseAllToken, query }`。节点用 `useState(initialOpen)`；`useEffect` 监听 `expandAllToken`/`collapseAllToken` 变化时 setOpen(true/false)。展开全部 bump `expandAllToken`（不强制超阈数组，见下）。
- 大数组懒展开：容器 entries 超 `LAZY_THRESHOLD=200` 时只渲染前 `page`（初始 200）+「加载更多」按钮；展开全部只保证容器 open，不改 `page`。

- [ ] **Step 1: 写失败测试**（`JsonTreeView.vitest.test.tsx`）

```tsx
import { render, screen, fireEvent } from "@testing-library/react"
import { JsonTreeView } from "@/components/tools/JsonTreeView"

test("expand all opens nested containers", () => {
  render(<JsonTreeView value={{ a: { b: { c: 1 } } }} toolbar />)
  fireEvent.click(screen.getByRole("button", { name: /expand all/i }))
  expect(screen.getByText("c")).toBeInTheDocument()
})
test("large array is lazily paged", () => {
  render(<JsonTreeView value={{ arr: Array.from({ length: 500 }, (_, i) => i) }} toolbar />)
  fireEvent.click(screen.getByRole("button", { name: /expand all/i }))
  expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument()
})
test("copy path copies JSON path", async () => {
  const spy = vi.spyOn(await import("@/lib/clipboard"), "copyText").mockResolvedValue(true)
  render(<JsonTreeView value={{ a: [{ b: 1 }] }} toolbar />)
  // 展开到 b，点其「copy path」，断言 copyText 收到 "$.a[0].b"
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `cd ui-v4 && bunx vitest run tests/JsonTreeView.vitest.test.tsx`。Expected: FAIL。

- [ ] **Step 3: 实现**（`JsonTreeView.tsx`）
  - `TreeNode` 加 `path: string`（root=`"$"`，child= `${path}.${key}` 或 `${path}[${i}]`）。
  - 每节点 hover 出「复制值」（`copyText(JSON.stringify(value, null, 2))`）与「复制 path」（`copyText(path)`）。
  - 加 `TreeContext`（expand/collapse token + query）；toolbar 渲染「expand all / collapse all / 搜索框」。
  - 搜索：query 非空时，命中 key/value 的节点高亮，其祖先强制展开。
  - 大数组懒展开：`entriesOf` 后若 `entries.length > LAZY_THRESHOLD`，`useState(page=LAZY_THRESHOLD)`，只 map 前 `page`，尾部「load more」+= 200。
  - `toolbar?: boolean` 默认 false，保持现有 3 调用方（含即将迁移的）不破坏。

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: 回归 + lint + 提交**

```bash
cd .. && bun run typecheck && bunx eslint ui-v4/src/components/tools/JsonTreeView.tsx
git add -- ui-v4/src/components/tools/JsonTreeView.tsx ui-v4/tests/JsonTreeView.vitest.test.tsx
git commit -m "feat(ui-v4): JsonTreeView expand-all, copy value/path, search, lazy large arrays"
```

---

## Task 3: RawJsonView 共享组件

**Files:**
- Create: `ui-v4/src/components/common/RawJsonView.tsx`
- Test: `ui-v4/tests/RawJsonView.vitest.test.tsx`（新建）

**Interfaces:**
- Produces: `<RawJsonView value defaultMode? label? className? />`。视图态 local，默认 `"source"`。source=增强 `CodeBlock code={stringify} toolbar`；tree=增强 `JsonTreeView value toolbar`。

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from "@testing-library/react"
import { RawJsonView } from "@/components/common/RawJsonView"

test("defaults to source view", () => {
  render(<RawJsonView value={{ a: 1 }} />)
  expect(screen.getByRole("tab", { name: /原文|source/i })).toHaveAttribute("aria-selected", "true")
})
test("can switch to tree", () => {
  render(<RawJsonView value={{ a: 1 }} />)
  fireEvent.click(screen.getByRole("tab", { name: /树|tree/i }))
  expect(screen.getByText("a")).toBeInTheDocument()
})
test("defaultMode=tree overrides", () => {
  render(<RawJsonView value={{ a: 1 }} defaultMode="tree" />)
  expect(screen.getByRole("tab", { name: /树|tree/i })).toHaveAttribute("aria-selected", "true")
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `cd ui-v4 && bunx vitest run tests/RawJsonView.vitest.test.tsx`。Expected: FAIL。

- [ ] **Step 3: 实现**（`RawJsonView.tsx`，参照 `JsonToolsPage` 的树/原文原型，用 Radix Tabs 或既有 tab 按钮风格）

```tsx
import { useMemo, useState } from "react"
import { CodeBlock } from "@/components/detail/CodeBlock"
import { JsonTreeView } from "@/components/tools/JsonTreeView"

type Mode = "tree" | "source"

/** 全站共享 raw JSON 双视图：默认 source，可切 tree。仅接结构化 JSON。 */
export function RawJsonView({
  value,
  defaultMode = "source",
  label,
  className,
}: {
  value: unknown
  defaultMode?: Mode
  label?: string
  className?: string
}) {
  const [mode, setMode] = useState<Mode>(defaultMode)
  const source = useMemo(() => JSON.stringify(value, null, 2), [value])
  return (
    <div className={`mono flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <div className="flex items-center gap-2 border-b border-[var(--color-border)]">
        {label ? <span className="px-2 text-[11px] uppercase text-[var(--color-muted)]">{label}</span> : null}
        {(["source", "tree"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            type="button"
            className={`-mb-px border-b-2 px-3 py-1 text-[11px] ${
              mode === m ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
            onClick={() => setMode(m)}
          >
            {m === "source" ? "原文" : "树"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "source" ?
          <CodeBlock
            code={source}
            toolbar
          />
        : <JsonTreeView
            key={source}
            value={value}
            toolbar
          />
        }
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: build + lint + 提交**

```bash
cd .. && bun run build:ui-v4 && bunx eslint ui-v4/src/components/common/RawJsonView.tsx
git add -- ui-v4/src/components/common/RawJsonView.tsx ui-v4/tests/RawJsonView.vitest.test.tsx
git commit -m "feat(ui-v4): add shared RawJsonView (source+tree, defaults source)"
```

---

## Task 4: 迁移模型详情 RawJsonTab + CapabilitiesTab

**Files:**
- Modify: `ui-v4/src/components/models/detail-tabs/RawJsonTab.tsx`
- Modify: `ui-v4/src/components/models/detail-tabs/CapabilitiesTab.tsx`
- Test: 既有 `ui-v4/tests/ModelDetail.vitest.test.tsx` 回归补充

- [ ] **Step 1: 迁移 RawJsonTab**（整文件）

```tsx
import type { Model } from "~backend/lib/models/client"
import { RawJsonView } from "@/components/common/RawJsonView"

/** Raw JSON tab：完整 model 对象，双视图（原文 + 树）。 */
export function RawJsonTab({ model }: { model: Model }) {
  return <RawJsonView value={model} />
}
```

- [ ] **Step 2: 迁移 CapabilitiesTab raw supports**（把 `<JsonTreeView value={supports} />` 换成 `<RawJsonView value={supports} />`，保留其余派生区不变）。

- [ ] **Step 3: 回归测试**：`cd ui-v4 && bunx vitest run tests/ModelDetail.vitest.test.tsx`，确认 Raw JSON tab + Capabilities raw map 仍渲染、可切视图（按需补断言）。

- [ ] **Step 4: build + lint + 提交**

```bash
cd .. && bun run build:ui-v4 && bunx eslint ui-v4/src/components/models/detail-tabs/RawJsonTab.tsx ui-v4/src/components/models/detail-tabs/CapabilitiesTab.tsx
git add -- ui-v4/src/components/models/detail-tabs/RawJsonTab.tsx ui-v4/src/components/models/detail-tabs/CapabilitiesTab.tsx ui-v4/tests/ModelDetail.vitest.test.tsx
git commit -m "feat(ui-v4): model detail RawJsonTab + Capabilities raw map use RawJsonView"
```

---

## Task 5: 迁移模型列表 Raw 视图（喂完整 envelope，修回退）

**Files:**
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Test: `ui-v4/tests/ModelsPage.vitest.test.tsx`

- [ ] **Step 1: 写失败测试**：Raw 视图渲染**完整 API 响应**（含 `{ data: … }` envelope），且可切树。

```tsx
test("raw view shows full API envelope, not just models array", () => {
  renderModelsPage(/* data = { data: [...] } */)
  fireEvent.click(screen.getByRole("button", { name: /raw json/i }))
  // 断言存在顶层 "data" 键（envelope），可切到树视图
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `cd ui-v4 && bunx vitest run tests/ModelsPage.vitest.test.tsx`。Expected: FAIL。

- [ ] **Step 3: 实现**（`ModelsPage.tsx`）把现 Raw 分支：
```tsx
      {raw ?
        <pre …>{JSON.stringify(models, null, 2)}</pre>
```
换成喂完整 `data`（含 envelope）的 `RawJsonView`：
```tsx
      {raw ?
        <RawJsonView value={data ?? { data: [] }} />
```
（`data` 是 `useModels()` 的 `{ data: Array<Model> }`；import `RawJsonView`。）

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint ui-v4/src/components/models/ModelsPage.tsx
git add -- ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/ModelsPage.vitest.test.tsx
git commit -m "fix(ui-v4): models list raw view shows full API envelope via RawJsonView"
```

> 注：若 Plan B（models-list-parity）也在改 `ModelsPage.tsx`，两 plan 对同文件的改动落在不同区块（Raw 分支 vs 头部/filter），共享 worktree 时用显式 pathspec commit 避免 index race（项目 CLAUDE.md concurrent-sessions）。

---

## Task 6: 重构 BlockJsonModal + JsonToolsPage 复用 RawJsonView

**Files:**
- Modify: `ui-v4/src/components/detail/BlockJsonModal.tsx`
- Modify: `ui-v4/src/components/tools/JsonToolsPage.tsx`
- Test: 既有相关测试回归

- [ ] **Step 1: BlockJsonModal**：把内部 Source/Tree 切换 + copy（`:45-97`）替换为 `<RawJsonView value={parsedValue} />`（保留 Modal 外壳、标题、关闭）。删除现在重复的 `view` state / Source·Tree 按钮 / 单独 copy（复制已在 `CodeBlock`/`JsonTreeView` toolbar 内）。默认 source 保持不变。

- [ ] **Step 2: JsonToolsPage**：Tool 2「JSON tree」的树/原文切换（`:34,115-131` + `renderTreePanel`）替换为 `<RawJsonView value={treeResult.value} />`（解析成功时）；解析失败/等待输入分支保留。删重复 `treeMode` state 与切换按钮。「→ 传入 Tree」按钮改为仅 `setTreeInput`（不再设 treeMode）。

- [ ] **Step 3: 回归测试**：跑二者既有测试（如 `ui-v4/tests/` 下相关文件）+ `bunx vitest run`，确认双视图仍工作、copy 仍可用。

- [ ] **Step 4: build + lint + 提交**

```bash
bun run build:ui-v4 && bunx eslint ui-v4/src/components/detail/BlockJsonModal.tsx ui-v4/src/components/tools/JsonToolsPage.tsx
git add -- ui-v4/src/components/detail/BlockJsonModal.tsx ui-v4/src/components/tools/JsonToolsPage.tsx
git commit -m "refactor(ui-v4): BlockJsonModal + JsonToolsPage reuse RawJsonView"
```

---

## Task 7: 迁移 segment 面 + block 面（含非 JSON 守卫）

**Files:**
- Modify: `ui-v4/src/components/detail/segments/StagesSegment.tsx`
- Modify: `ui-v4/src/components/detail/segments/ResponseSegment.tsx`
- Modify: `ui-v4/src/components/detail/segments/ConvoSegment.tsx`
- Modify: `ui-v4/src/components/detail/blocks/ToolUseBlock.tsx`
- Modify: `ui-v4/src/components/detail/blocks/ToolResultBlock.tsx`
- Modify: `ui-v4/src/components/detail/blocks/GenericBlock.tsx`
- Test: 各面既有测试回归

**Interfaces:**
- 判定辅助（内联即可）：内容确为 object/array → `RawJsonView`；纯字符串/SSE/error 文本 → 保留 `<pre>`/`RawPre`。

- [ ] **Step 1: segment 面**（逐个）：在既有 Raw/Code 语义分支内，把 Raw/Code 用 `CodeBlock` 或裸 `RawPre` 渲染 JSON 的地方换为 `RawJsonView`（当分支内容是结构化 JSON 对象时）。**外层 Rendered/Raw 语义切换保留不动**——仅内层原始呈现换成双视图。SSE `frames.map(f=>f.raw).join()`、`error` 文本、`rawBody`（非 JSON 时）**保留 `RawPre`**。
  - `ResponseSegment.tsx:137-157`：Code 分支若内容可 `JSON.parse` 成对象则 `RawJsonView value={parsed}`，否则保留 `RawPre`。
  - `StagesSegment.tsx:183-193`、`ConvoSegment.tsx:70-78` 同理。

- [ ] **Step 2: block 面**：`ToolUseBlock`（input JSON）、`GenericBlock`（结构化 JSON）用 `RawJsonView`；`ToolResultBlock.tsx:21` 纯字符串内容**保留 `<pre>`**，仅当内容是结构化 JSON 时才 `RawJsonView`。

- [ ] **Step 3: 逐面回归**：每改一个面，跑其既有测试（`ui-v4/tests/` 下对应文件）+ 目视 diff 确认非 JSON 分支未被误改。

- [ ] **Step 4: build + lint + 分面提交**（每个语义单元一提交，或按 segment/block 分两提交）

```bash
bun run build:ui-v4 && bunx eslint <改动文件…>
git add -- <精确路径…>
git commit -m "feat(ui-v4): detail segments/blocks use RawJsonView for structured JSON (keep <pre> for non-JSON)"
```

---

## 收尾（全部 7 task 后）

- [ ] 全站 grep 复核：`grep -rnE 'JSON.stringify|<pre' ui-v4/src` 确认剩余 `<pre>` 都是**有意的非 JSON 文本**（SSE/error/纯字符串），无遗漏的 raw JSON 面。
- [ ] `cd ui-v4 && bunx vitest run` 全绿；`bun run build:ui-v4` 绿。
- [ ] 用最大真实样本（整条 history entry 规范全量）实测 source（>500 行展开）+ tree（大数组懒展开）性能（empirical-verification）。
- [ ] 对照 spec §7 验收逐条核对；确认 `ConfigPage`/`MessageDiffView` 未被误迁。
- [ ] subagent code-review（裁判轴：长远正确 + 完整；重点核 non-JSON 守卫、copyText 复用、无新依赖）。
- [ ] doc-sync：spec 状态改 landed；若涉活架构更新 `docs/DESIGN.md`。

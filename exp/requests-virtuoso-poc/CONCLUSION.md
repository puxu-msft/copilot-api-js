# PoC 结论：TableVirtuoso + TanStack Table + jsdom vitest（list-engine gate）

> 日期：2026-07-07 · 状态：**成功（三库组合在 jsdom 下真跑绿）**
> 目的：Phase 3 全量重写 `HistoryList` 前的 gate——实测 `react-virtuoso` 的 `TableVirtuoso` + `@tanstack/react-table`（`flexRender`）+ jsdom vitest 三者能跑通，并留下**确切的 jsdom stub 方案**供 Task 3.2 正式测试复用。**不接生产路由，仅取证。**

## 装的版本

| 包 | 版本 | 位置 |
|---|---|---|
| `react-virtuoso` | **4.18.10** | `ui-v4/package.json` dependencies（新增）+ 根 `bun.lock` |
| `@tanstack/react-table` | 8.21.3 | 已在 dependencies（无需新装） |

## PoC 代码与运行位置

- **可运行测试**（vitest 真跑）：[`ui-v4/tests/requests-virtuoso.poc.vitest.test.tsx`](../../ui-v4/tests/requests-virtuoso.poc.vitest.test.tsx)（组件 `PocTable` 内联其中）。
- **本目录的 `PocTable-and-test.reference.tsx`**：上文件的取证副本（不参与运行，纯留档）。
- **为何测试放 `ui-v4/tests/` 而非 `exp/`**：`ui-v4/vitest.config.ts` 的 `include` 是 `tests/**/*.vitest.test.{ts,tsx}`，root 隐式为 `ui-v4/`。vitest 只收集 root 下 include 命中的文件；`exp/`（仓库根、`ui-v4/` 之外）**不被收集**，CLI 位置参数也无法 reach（位置参数只是对已收集集合的过滤）。故 PoC 测试必须落在 `ui-v4/tests/` 才能真跑。命名 `*.poc.vitest.test.tsx` 仍匹配 `*.vitest.test.tsx`，会进常规 `test:vitest` 套件——这是刻意的（保证 gate 长期不回归）。

## 运行命令与结果

```
cd ui-v4 && bunx vitest run tests/requests-virtuoso.poc.vitest.test.tsx
# Test Files  1 passed (1) · Tests  2 passed (2)
```

两条断言：
1. jsdom 下渲染出 ≥1 行数据（`getAllByTestId("poc-row")`）+ `accessorFn`/`flexRender` 跑通（单元格文本出现）+ `fixedHeaderContent` sticky header 存在（`position: sticky`）+ 表头来自 TanStack `headerGroups`。
2. `VirtuosoHandle.scrollToIndex({ index: 10, align: "center" })` 经 `forwardRef` 调用**不抛**。

## 最终有效的 jsdom stub 方案（确切代码，Task 3.2 复用）

**一句话**：载荷 = `tests/setup.ts` 已有的 global `ResizeObserver` stub + `TableVirtuoso` 的 `initialItemCount` prop；**尺寸 stub（offsetHeight/getBoundingClientRect）不需要**。

### ① global ResizeObserver stub —— 已在 `ui-v4/tests/setup.ts`（无需重复）

```ts
// tests/setup.ts 已有(Radix 也依赖它)。不 stub 则 Virtuoso 构造 ResizeObserver 即 throw。
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
```

### ② `initialItemCount` prop —— 真正让 jsdom 渲染出行的机制

```tsx
<TableVirtuoso
  data={rows}
  initialItemCount={Math.min(rows.length, 20)}  // jsdom 无 layout,靠它强制首屏渲染 N 行
  ...
/>
```

这是 react-virtuoso 文档建议的 SSR/测试渲染手段：在没有 layout 测量时强制渲染前 N 项。

## 载荷分析（实测，非推断——empirical-verification）

用三个隔离探针文件实测（跑完即删）：

| 场景 | offsetHeight/BCR 尺寸 stub | `initialItemCount` | 渲染行数 |
|---|---|---|---|
| A 基线 | 无 | 无 | **0**（失败模式） |
| B 只加尺寸 stub | `offsetHeight=800` + `getBoundingClientRect` | 无 | **0** |
| C/D 只加 `initialItemCount` | 无 | `10` | **10** ✅ |

**结论**：在 react-virtuoso@4.18.10 + jsdom(29) 下，`Object.defineProperty(HTMLElement.prototype, "offsetHeight", { get: () => 800 })` 这类尺寸 stub **单独加不足以**让 Virtuoso 渲染出行（实测仍 0 行）；真正载荷是 `initialItemCount`。故计划文档里"尺寸 stub 让它渲染"的假设**被实测推翻**，Task 3.2 应以 `initialItemCount` 为准，尺寸 stub 仅作可选后备（若未来某断言依赖真实测量再引入）。`scrollToIndex` 在无尺寸 stub 下亦不抛。

## TableVirtuoso + TanStack 集成要点

1. **数据源**：`data={table.getRowModel().rows}`（把 TanStack 行数组直接喂给 `TableVirtuoso`）。
2. **表头**：`fixedHeaderContent={() => table.getHeaderGroups().map(hg => <tr>{hg.headers.map(h => <th>{flexRender(h.column.columnDef.header, h.getContext())}</th>)}</tr>)}`——sticky/fixed header 由 Virtuoso 的 `fixedHeaderContent` 负责，配 `position: sticky`。
3. **行内容**：`itemContent={(index, row) => row.getVisibleCells().map(cell => <td>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}`——**只返回 `<td>` 单元格**，`<tr>` 由 `components.TableRow` 包。
4. **components**：`Table`/`TableRow`（+ 可选 `TableHead`/`TableBody`）——注意 `Table` 组件要透传 `style`（Virtuoso 传入布局样式），`TableRow` 透传 `props`（含 `data-index` 等 Virtuoso 内部属性）。
5. **列可见性**（Task 3.2）：`row.getVisibleCells()` 天然尊重 TanStack `columnVisibility` state——隐藏列不出现在 cells 里，无需额外过滤。
6. **imperative 定位**：`const ref = useRef<VirtuosoHandle>(null)`；`ref.current?.scrollToIndex({ index, align: "center" })`——Task 3.3 的 `?at=` 定位用它替换旧 `scrollIntoView`。

## 坑

- **测试可 reach 性**：vitest include 锁在 `ui-v4/tests/`，PoC 测试**不能**放 `exp/`（详见上文"运行位置"）。这是 gate 交付形态的硬约束。
- **计划假设需实测校准**：计划里"offsetHeight stub 让 Virtuoso 渲染"是**错的**（实测 B 仍 0 行），载荷是 `initialItemCount`。
- **`components.Table` 必须透传 `style`**：Virtuoso 靠往 `Table` 注入内联样式做布局；吞掉 `style` 会破坏渲染。
- **`.poc.vitest.test.tsx` 进常规套件**：因命名匹配 include，它会随 `bun run test:vitest` 一起跑。gate 语义下这是好事（长期防回归）；但 Task 3.2 落地正式 `HistoryList.vitest.test.tsx` 后，本 PoC 测试是否保留可复议（当前保留，无害）。

## 一句话

**Gate 通过**：`TableVirtuoso`(4.18.10) + TanStack Table(8.21.3) + jsdom vitest 三者实测跑绿（2/2），确切 stub = **global ResizeObserver（setup.ts 已有）+ `initialItemCount` prop**，尺寸 stub 经实测**不需要**。可放行 Phase 3 全量重写。

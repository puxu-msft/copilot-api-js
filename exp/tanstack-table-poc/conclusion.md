# PoC 结论：TanStack Table 替换 Models 手写表格

> 日期：2026-07-05 · 状态：**成功（可行 + 有实证收益）**
> 目的：为 [headless 组件栈 ADR](../../ui-v4/docs/decisions/2026-07-05-headless-component-stack.md) 提供实证——验证 **TanStack Table (v8)** 能否替掉 ui-v4 Models 表格里手写的排序 + 列可见性,并保持 Terminal Amber 定制视觉。
> PoC 代码（保留,受构建/测试保护,未接生产路由）：
> - 组件 [ui-v4/src/components/models/ModelsTableTanstack.poc.tsx](../../ui-v4/src/components/models/ModelsTableTanstack.poc.tsx)
> - 测试 [ui-v4/tests/ModelsTableTanstack.poc.vitest.test.tsx](../../ui-v4/tests/ModelsTableTanstack.poc.vitest.test.tsx)

## 验证结论（全部实测)

| 维度 | 手写现状 | TanStack Table | 结论 |
|---|---|---|---|
| **排序** | `model-filters.ts:64-94` `sortModels`（31 行 key-switch）+ ModelsPage `sort` state/`onSort`（~3 行）+ ModelsTable `caret`/`ariaSort`/`sortable`（~26 行） | `getSortedRowModel()` + `onSortingChange` + accessorFn;智能默认（数值 desc-first，实测） | ✅ **排序逻辑本身净删 ~30 行**（sortModels 的 switch/localeCompare 被取代）；渲染层/列配置是**平移非净删**（PoC 自己重写 columns memo + thead + `ariaSortAttr`/`sortArrow`） |
| **列可见性** | `model-columns.ts:34-52`（~19 行 merge）+ ModelsPage toggle/persist | TanStack `VisibilityState` 内建 | ✅ 逻辑归库，菜单/持久化仍自控 |
| **派生列**（能力矩阵） | ModelsTable `capsById` + 逐单元格 | `accessorFn: r => r.caps.vision`（**渲染已验**；排序未在 PoC 断言，但库能力支持） | ✅ 渲染 |
| **join 列**（Req 7d 遥测） | 手写单元格 | `accessorFn: r => r.req`（**渲染已验**；排序未在 PoC 断言） | ✅ 渲染 |
| **视觉（Terminal Amber）** | 手写 `<table>` + tokens | headless → 自渲染同一 `<table>`/class（**库性质保证无自带样式；PoC 未做视觉回归断言**） | ✅ 库性质 |
| **a11y** | P3/P4 手补 `<th>` scope + 排序 button + aria-sort | TanStack **纯逻辑到 a11y 也自写**（PoC 手写 `ariaSortAttr`/`sortArrow`）;`getIsSorted`→aria-sort | ⚠ 平齐但 a11y 仍需自写（对比 react-aria 会白送，见 ADR 待评估项） |
| **bundle** | — | **单库、一次性手测、已还原**：+13.7kB gzip（index 224.5→238.2kB）。**四库全栈增量未测** | ⚠ 单库快照，非门禁 |
| **兼容** | — | `typecheck`/`build`/`eslint`/`test` 全绿;`~backend` 对 `client.ts` **仅 type-only import**（运行时擦除）、对 `capabilities.ts` value import 经核不拉 client 运行时——故 rollup 图纯（注意 client.ts 本身非纯，import `~/lib/state`，前端**永不可** value-import） | ✅ |

## 关键实证细节
- **测试 3/3 绿**：派生+join 列**渲染**;点表头**排序**（数值 desc-first 智能默认 → asc）;隐藏列不渲染。（未验：派生/join 列的**排序**、多列排序、faceting、视觉一致性——这些是库能力推断非 PoC 断言。）
- **视觉自控**：TanStack Table headless（无自带样式）→ 与 rounded:0/amber/mono 工业风零冲突（**库性质保证；PoC 未做视觉回归断言**）。方向性实证："定制视觉项目该用 headless、不用 styled UI kit"。
- **代码**：排序逻辑净删 ~30 行（`sortModels` switch 被取代）+ 列可见性归 `VisibilityState`;**渲染层/列配置平移非净删**（headless 代价）。
- **bundle**：单库、一次性手工临时接线量得 +13.7kB gzip，随即还原。**四库全栈增量未测。**

## 落地路径（非本 PoC 范围,ADR 记录）
PoC 成功 → 落地时用（ADR 定稿的）数据表方案正式重写 `ModelsTable`,并作 Requests 列表 + 6 维筛选地基。**PoC 组件 `.poc.tsx` + 其测试须在正式重写的同一提交删除**（否则是"未接路由组件 + 续命测试"死代码，项目 knip 假阴性活体）；此前在 `docs/todo/deferred-backlog.md` 登记 + tripwire 守护。

## 一句话
**PoC 成功但需诚实标定**：TanStack Table 可行（3/3 证排序+列可见+渲染）、排序逻辑净删 ~30 行、视觉零冲突（库性质）、单库 +13.7kB gzip——**背书方向**（headless 数据表 > 手写）。但只证 **TanStack Table 一个库可行**,不证 ADR 的**四库栈是最优**——强替代 **react-aria**（单 vendor 覆盖 table/combobox/virtual/datepicker + a11y grid 白送）尚未评估，见 ADR。

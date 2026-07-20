# Spec: ui-v4 Raw JSON 双视图共享组件

- 日期：2026-07-08
- 状态：**landed**（7 task subagent-driven 执行完毕；分支 `feat/ui-v4-raw-json-dual-view`，12 commits `f5d36cd6..4496ac8c`；全站 raw JSON 面已迁移，ConfigPage/MessageDiffView 排除到位；68/68 目标 vitest + 全量 339 tests 绿、build:ui-v4 绿；最终全分支 review READY TO MERGE。执行期新增 §4 遗漏面 `SystemSegment`（结构化 system → RawJsonView、string → `<pre>`，与 ConvoSegment 同类）。）
- 归属：ui-v4 前端子项目；服务「增量淘汰 Vue `ui/`」路线图
- 相关：[docs/DESIGN.md](../DESIGN.md)、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、姊妹 spec [ui-v4-models-list-parity](2026-07-08-ui-v4-models-list-parity.md)

## 1. 目标与动机（what & why）

ui-v4 里展示 raw JSON 的地方各写各的：有的只读 shiki 高亮（`CodeBlock`），有的裸 `<pre>{JSON.stringify(...)}`，有的可折叠树（`JsonTreeView`），体验割裂，且部分面信息还退化（模型列表 Raw 视图只 dump `models` 数组、丢了 API envelope）。

**目标**：抽一个全站共享的 `<RawJsonView>`，**永远同时提供两种视图**——① 高亮只读代码视图（shiki `CodeBlock` 增强），② 可折叠 JSON tree（自研 `JsonTreeView` 增强）——铺到 ui-v4 所有 raw JSON 面。用户可在两视图间切换，偏好持久化。

**为何**：统一体验 + 补足能力（复制、搜索、折叠、path），是 Vue 版 Raw 视图的超集，为下线 Vue `ui/` 扫清「Raw JSON 呈现弱化」这一回退项。

## 2. 非目标

- 不引入重型第三方库（`@textea/json-viewer` / Monaco / CodeMirror）——已裁决：增强现有自研积木，零新依赖，主题 100% 贴合 Terminal Amber。
- 不做 JSON 编辑/写回（Raw JSON 展示是只读语义）。
- **不动 `ConfigPage`**：它是**可编辑回写编辑器**（`ConfigPage.tsx:17-25` `JSON.parse(text)` → `save.mutate`，`:50-55` 受控 `<textarea>`），不是只读 raw JSON 展示面，迁到只读 `RawJsonView` 会删除保存功能——明确排除，不属本 spec。
- 不动 `MessageDiffView`（`detail/diff/MessageDiffView.tsx:24` 的 `JSON.stringify` 是 diff 文本源，非独立 raw JSON 视图）。
- 不改后端返回的数据形状（仅前端呈现层）。

## 3. 组件契约

### 3.1 `<RawJsonView>`

位置：`ui-v4/src/components/common/RawJsonView.tsx`

> **既有原型**：目标「树/原文 + Copy」模式已在两处独立实现——`JsonToolsPage`（`:34,115-131` 树/原文 tab）与 `BlockJsonModal`（`:45-97` Source/Tree + `copyText`）。`RawJsonView` 是把这两个原型**上提为共享组件**，二者随后重构为复用它（非从零造）。复制统一复用 `ui-v4/src/lib/clipboard.ts` 的 `copyText`（含 http-LAN 非安全上下文 fallback），不重造。

```ts
interface RawJsonViewProps {
  /**
   * 已 parse 的 JSON 值（对象/数组）。source 视图内部 stringify。
   * 语义仅面向**结构化 JSON**；非结构化回退文本（如 SSE raw、error 文本、
   * 纯字符串 tool_result）不走本组件，保留各面既有 `<pre>`/`RawPre`（见 §4 注）。
   */
  value: unknown
  /** 覆盖初始视图；缺省 "source"。 */
  defaultMode?: "tree" | "source"
  /** 可选顶部标签（如 "response body"）。 */
  label?: string
  /** 可选：外部约束高度/自适应容器（默认填充 min-h-0 flex-1）。 */
  className?: string
}
```

行为：
- 顶部工具栏：视图切换 tab「树 / 原文」+ 右侧动作区（复制、以及各视图特有动作）。
- **视图态每实例独立、不持久化**（local component state），**默认 `source`**——不设全局/localStorage 偏好键。这保持 `BlockJsonModal` 现有默认（source）不变，无翻转副作用。
- `source` 视图：`JSON.stringify(value, null, 2)` → 增强版 `CodeBlock`。
- `tree` 视图：`value` → 增强版 `JsonTreeView`。
- `value` 变化时 tree 折叠态按深度默认重置（沿用 `JsonToolsPage` 的 `key={source}` 重挂做法）。

### 3.2 `CodeBlock` 增强（只读 shiki，新增能力）

现状：`ui-v4/src/components/detail/CodeBlock.tsx` 只读高亮 + 行号。**>500 行截断不在此**——在共享 `LineNumberedText.tsx:28-58` 的 `LineGutter`（`INITIAL_LINE_LIMIT=500` + 已有「显示全部 N 行」展开按钮），故截断/展开**已实现、无需改**。新增（不破坏现有调用方，能力经 props 可选开启，`RawJsonView` 内默认开）：
- **一键复制**：复用 `copyText` 复制 source 全文，短暂「copied」反馈。
- **软换行切换**：`whitespace-pre`（横向滚动）↔ `whitespace-pre-wrap`（换行），local ephemeral（不持久化）。
- **块内搜索定位**（**行级**）：输入框高亮**命中行**（不做跨 token 的子串级高亮，因 shiki 已按 token 切 `<span>`），`n`/`N` 或上下键在命中行间跳转并滚动到视口。搜索是「高亮 + 跳转」，不隐藏非命中行。

### 3.3 `JsonTreeView` 增强（自研 Radix 树，新增能力）

现状：`ui-v4/src/components/tools/JsonTreeView.tsx` Radix `Collapsible` + 主题色 + 深度自动折叠。新增：
- **展开/折叠全部**：顶部两个动作，递归控制所有节点开合（需把 open 态从每节点 local state 提升为受控/共享，见 §5 风险）。
- **复制节点值**：每个容器/叶子节点 hover 出「复制值」（`copyText(JSON.stringify(子树))`，作用于底层数据非 DOM）。
- **复制 JSON path**：每个节点「复制 path」（如 `$.attempts[0].upstreamResponse.error`）。
- **类型标注**：容器摘要旁标注类型/长度（已有 `{…} N keys`/`[…] N items`，补叶子的 `string(len)` 等可选）。
- **搜索高亮**：输入框匹配 key/value，命中节点高亮、祖先自动展开。
- **大数组懒展开**：超阈值（如 >200 项）的数组分页/「加载更多」而非一次渲染全部，避免深大结构卡顿。**与「展开全部」的优先级**：展开全部**不**强制展开超阈数组（仅展开其容器一层、余项仍走懒加载），见 §5 不变量。

## 4. 覆盖面（迁移清单）

全站所有 raw JSON 展示面统一改用 `<RawJsonView>`（或其增强后的 `CodeBlock`/`JsonTreeView`）：

| # | 面 | 现状（已核实） | 迁移后 |
|---|---|---|---|
| 1 | 模型详情 RawJsonTab（`detail-tabs/RawJsonTab.tsx:14`） | 仅 `CodeBlock`（tree 缺失） | `RawJsonView`（双视图） |
| 2 | 模型详情 CapabilitiesTab（`detail-tabs/CapabilitiesTab.tsx:55`） | 仅 `JsonTreeView`（source 缺失）展示 raw `supports` map | `RawJsonView`（双视图） |
| 3 | 模型列表 Raw 视图（`ModelsPage.tsx:168-169`） | 裸 `<pre>` 且只 dump `data.data` 数组、丢 `{ data: … }` envelope | `RawJsonView`，喂**完整 API 响应**（含 envelope，修回退） |
| 4 | history 详情 `BlockJsonModal`（`:45-97`） | **已是** Source/Tree + `copyText` 双视图（目标模式现成原型） | 重构为复用 `RawJsonView`，删重复切换代码 |
| 5 | `JsonToolsPage`（`:115-131`） | **已自带**树/原文切换原型 | 重构为复用 `RawJsonView`，删重复切换代码 |
| 6 | `StagesSegment`（`:183-193`）/ `ResponseSegment`（`:137-157`）/ `ConvoSegment`（`:70-78`） | 均已有 **Raw/Rendered（或 Raw/Conversation）语义切换**，Raw 分支各用 `CodeBlock` 或裸 `RawPre` | 保留外层语义切换，其 **Raw/Code 分支内嵌 `RawJsonView`**（当分支内容确为结构化 JSON 时）；SSE raw、error 文本等非结构化回退保留 `RawPre` |
| 7 | `ToolUseBlock` / `ToolResultBlock` / `GenericBlock` | 结构化 input/JSON 用 `CodeBlock`/tree；`ToolResultBlock.tsx:21` 纯字符串内容走裸 `<pre>` | 结构化 JSON 用 `RawJsonView`；纯字符串/非 JSON 内容**保留 `<pre>`**（§3.1 value 语义） |

排除（明确不迁）：`ConfigPage`（编辑器，§2 非目标）、`MessageDiffView`（diff 文本源，§2 非目标）。

> **两级 toggle 语义（#6）**：外层 Raw/Rendered 是「原始 vs 富渲染」轴，内层 tree/source 是「原始的两种呈现」轴，正交、不冲突——用户先选 Raw，再在 Raw 内选 tree/source。
> **非结构化降级（#6/#7）**：`RawJsonView` 只接结构化 JSON；面在传入前判定内容类型，纯字符串/SSE/error 回退文本继续走既有 `<pre>`/`RawPre`，不强塞进 `JSON.stringify`（否则加引号转义、tree 退化为单 primitive）。

## 5. 风险与决策

- **折叠态提升**：现 `JsonTreeView` 的 open 态是每 `TreeNode` 的 `useState`，「展开/折叠全部」需要外部批量控制。方案：引入一个树级 `expandVersion`/受控 open 映射或 context，节点订阅。plan 阶段定具体形状；不变量：单节点手动开合仍即时、批量操作 O(节点数) 且不破坏 `key` 重挂重置语义。
- **展开全部 × 大数组懒展开**：二者对超阈数组冲突。**不变量**：展开全部只展开容器结构，**不**强制物化超阈（>200 项）数组的全部子项——超阈数组仍保持懒加载「加载更多」，展开全部只保证其容器可见。
- **搜索在两视图语义不同**：source 视图搜文本、**行级**高亮 + 跳转（不做跨 token 子串级）；tree 视图搜 key/value 节点、高亮 + 祖先展开。两者独立实现、不强行统一，但共享输入框 UI 风格。
- **非结构化 value**：`RawJsonView` 契约仅结构化 JSON；各面在传入前判定，非 JSON 文本保留 `<pre>`（§4 注）。避免 `JSON.stringify(字符串)` 的引号/转义污染。
- **性能**：超大 JSON（如整条 history entry 规范全量形式）——source 靠 `LineGutter` 已有 >500 行展开、tree 靠大数组懒展开兜底；plan 需对最大真实样本实测（empirical-verification）。
- **视觉风格（非阻塞）**：本轮 §4#6 的两级 toggle（外层 Raw/Rendered × 内层 tree/source）先按现有 Terminal Amber 风格落地；整体视觉风格（含 toggle affordance 的呈现）留待**未来 ui-v4 全面视觉重构**统一处理，不阻塞本 spec 的功能落地。

## 6. 测试

- 单元/组件（vitest + @testing-library/react，jsdom）：
  - `RawJsonView` 默认渲染 source 视图、可切到 tree（视图态 local ephemeral，不持久化）。
  - `CodeBlock` 复制写剪贴板（mock clipboard）、软换行切换 class、搜索命中计数、>500 行展开。
  - `JsonTreeView` 展开/折叠全部、复制值/path、搜索高亮祖先展开、大数组懒展开阈值。
  - 遵循 [debugging-frontend-tests](../../.claude/skills/debugging-frontend-tests/SKILL.md)：portal 落 body、shiki 异步首帧 plaintext、否定断言先证正向。
- `~backend/*` 纯度：组件不得 import `~/lib/state`；交付跑 `bun run build:ui-v4`（typecheck + vitest 会假绿，rollup 才暴露）。

## 7. 验收标准

1. 全站 §4 所有面均走 `<RawJsonView>`，每处都能在「树/原文」间切换，默认 source、视图态每实例独立不持久化。
2. 模型列表 Raw 视图展示完整 API 响应（含 envelope），不再只 dump `models` 数组。
3. 两视图均支持复制；tree 支持复制节点值/path + 展开折叠全部 + 搜索；source 支持软换行 + 搜索 + >500 行展开。
4. 零新增第三方依赖；`bun run build:ui-v4` 绿；`bunx eslint <改动文件>`（无缓存）绿。
5. 呈现能力是 Vue 版 Raw 视图的超集（对照 `ui/` 的 `JsonViewerSurface` + Copy 按钮）。

# 设计：请求详情页 per-block JSON Modal

日期：2026-07-05
状态：设计定稿（待实现）

## 问题

v4 请求详情页目前只有 [ConvoSegment](../../src/components/detail/segments/ConvoSegment.tsx) 顶层一个「Rendered / Raw body」切换（一次性 dump 整个 `inboundRequest`）。单个内容块层面看不到原始 JSON：

- `TextBlock` / `ThinkingBlock` / `ImageBlock` / `ToolResultBlock` —— 完全没有查看 JSON 的入口。
- `ToolUseBlock` 只显示 `input` 的 JSON，看不到完整 block（`id`/`name`/`cache_control` 等）。
- 只有 `GenericBlock`（未知类型兜底）dump 整块。

即用户所说「应该可以查看每个 block 的 json，现在完全做不到」。

## 目标

每个内容块都能查看**完整原始 block 对象**的 JSON。设计以模块化、可维护、可定制为第一约束（用户明确要求）。

## 决策（已与用户敲定）

| 维度 | 决策 |
|---|---|
| 入口交互 | 每块右上角 hover 浮现的 `{ }` 图标 → 点击弹**居中 Modal** |
| 弹层形式 | 居中 overlay + 半透明背景，ESC / 点背景关闭 |
| JSON 渲染 | Modal 内 **Source（shiki 高亮）/ Tree（可折叠树）** 切换 |
| 复制 | Modal 内带 **Copy** 按钮 |
| 覆盖范围 | **所有内容块**（text / thinking / tool_use / tool_result / image / generic），从 `ContentRenderer` 统一插入 |

## 架构

单一插入点：[ContentRenderer](../../src/components/detail/ContentRenderer.tsx) 的 per-block wrapper。它被 `ConversationView`（请求消息）、`ResponseSegment`（上游 + forwarded 响应，经 `MessageBlock`）、`ToolResultBlock`（嵌套内容，直接调 `ContentRenderer`）共用，故一处插入即覆盖请求侧、响应侧、嵌套块全部路径。

**被否决的替代方案**：逐个编辑 6 个 block 组件各自加图标 —— 重复、易漂移、6 处维护点，违背模块化目标。

### 新文件（4）+ 改文件（1）

1. **`src/components/shared/Modal.tsx`（新，可复用原语）**
   居中 overlay，`createPortal` 到 `document.body`。`role="dialog"` + `aria-modal="true"`；监听 ESC 关闭；点背景关闭，点内容区 `stopPropagation`；header 含 `title` + `×` 关闭按钮。ui-v4 此前无任何 modal，这是第一个共享原语，放 `components/shared/` 供全 app 复用。
   Props：`{ title?: ReactNode; onClose: () => void; children: ReactNode }`。

2. **`src/lib/clipboard.ts`（新）**
   `copyText(text: string): Promise<boolean>` —— `navigator.clipboard.writeText` 为主，`document.execCommand("copy")` 兜底（旧环境/非安全上下文），返回是否成功。ui-v4 此前全无 clipboard（`docs/TODO.md` 已标记「复制全缺」），这是第一个入口，独立成 lib 便于全局复用与测试。

3. **`src/components/detail/BlockJsonModal.tsx`（新）**
   `{ value: unknown; onClose: () => void }`。渲染 `Modal`，body 内：
   - 工具栏：`Source / Tree` 切换（本地 `useState`）+ `Copy` 按钮（复制 `JSON.stringify(value, null, 2)`，成功后短暂显示 "Copied"）。
   - 视图：`Source` → 复用 [CodeBlock](../../src/components/detail/CodeBlock.tsx)（`lang="json"`）；`Tree` → 复用 [JsonTreeView](../../src/components/tools/JsonTreeView.tsx)。
   - 标题：`` `${blockType} JSON` ``，`blockType` 从 `value.type` 尽力取，取不到用 `"block"`。

4. **`src/components/detail/BlockChrome.tsx`（新）**
   `{ block: ContentBlock; id?: string; children: ReactNode }`。`group relative` 容器；绝对定位 hover 图标按钮（`opacity-0 group-hover:opacity-100 focus:opacity-100`，`aria-label="View block JSON"`，`{ }` 字形）；自持 `open` 状态，`open` 时渲染 `<BlockJsonModal value={block} onClose={...} />`。`id` 透传到容器 div 承载 DOM 锚点。

5. **改 [ContentRenderer.tsx](../../src/components/detail/ContentRenderer.tsx)**
   现有「anchored 时包 id div / 否则裸 ErrorBoundary」双分支，统一为：
   ```tsx
   blocks.map((block, i) => (
     <BlockChrome key={i} block={block} id={anchored ? `${anchorPrefix}-msg-${messageIndex}-blk-${i}` : undefined}>
       <ErrorBoundary label={block.type}>{renderBlock(block)}</ErrorBoundary>
     </BlockChrome>
   ))
   ```
   锚点 id 由 BlockChrome 的容器承载，DOM 锚点语义不变（`useAnchorScroll` 仍能命中）。

## 数据流

`ContentRenderer` 已持有每个 `block: ContentBlock`（原始对象）。`BlockChrome` 原样透传给 `BlockJsonModal`，后者只做 `JSON.stringify` / 交给 `JsonTreeView`。无新数据获取、无 store 改动、无后端改动 —— 纯展示层。符合 richest-data-flow：原始 block 完整对象直接呈现，不裁剪字段。

## 边界与错误处理

- **大 JSON**（tool_use.input / tool_result.content）：Modal 内容区 `max-h` + `overflow-auto`，不受 block 宽度限制。
- **循环引用**：block 对象来自 JSON 反序列化的 history，无循环；`JSON.stringify` 安全。
- **嵌套 tool_result**：其内部 `ContentRenderer` 的子块同样获得各自的 `{ }` 图标（符合「每个 block」预期）。外层 tool_result 图标显示整个 tool_result 对象、内层显示各子块 —— 层级清晰。
- **多 Modal**：每个 BlockChrome 自持 open 状态；实际交互一次只开一个。关闭态渲染 `null`，无开销。
- **焦点/滚动**：ESC 关闭；Modal 打开时不强制 body scroll-lock（内部工具、够用），如需可后续加。

## 样式

沿用 Terminal Amber 主题 token（`--color-border/muted/primary/surface/bg`）。Modal 背景 `bg-black/60`，内容区 `bg-[var(--color-surface)] border border-[var(--color-border)]`，`z-50`（与既有 `TocSidebar` 的 `z-50` 一致）。图标按钮低调，仅 hover/focus 浮现，不干扰正常阅读。

## 测试（vitest + @testing-library/react，jsdom）

- `Modal.vitest.test.tsx`：渲染 children；ESC 触发 `onClose`；点背景触发 `onClose`；点内容区不触发。
- `clipboard.bun.test.ts`：`copyText` 调用 `navigator.clipboard.writeText`（mock）；兜底路径。
- `BlockJsonModal.vitest.test.tsx`：默认 Source 视图显示 JSON；切 Tree 显示树；Copy 调 clipboard；标题含 block type。
- 扩展 `ContentRenderer.vitest.test.tsx`：每块渲染出 `View block JSON` 按钮（`getAllByLabelText`）；点击后 Modal 出现该块 JSON。

## 非目标（本次不做）

- System 消息块、message 整体的 JSON 图标（用户选了「仅所有内容块」）。如需，未来在 `SystemMessage` / `MessageBlock` 各自接入同一 `BlockJsonModal`，原语已可复用。
- body scroll-lock、焦点陷阱等 modal 高级可达性增强 —— 内部工具当前不需要，原语留有扩展位。

# ui-v4 Plan 08 — 详情页分离 + Convo/Stages 树状导航(TOC)实现计划

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。用户 2026-06-24 拍板:① 详情/列表**完全两路由全屏分离**(反转 DESIGN §4 主从一体)② Convo/Stages 加**左侧 TOC 树 + 右内容**导航。

**Goal:**
- **A 页面分离**:`/requests` = 列表全屏(Live 泳道 + History)、`/requests/:id` = 详情全屏(返回按钮 + DetailPanel),点行导航过去、深链直达。
- **B 树状导航**:详情 Convo/Stages 段加左侧可折叠 TOC 树(消息 role → 块 type 作节点),点击滚动跳转 + 瞬时高亮;内容仍在右侧完整渲染。

## 现状锚点(deep-read 实证)

- 路由 `src/App.tsx`:`/requests` 与 `/requests/:id` **都**渲 `RequestsWorkbench`(主从一体)。`AppShell` = NavRail + TopBar + `<Outlet/>`(`<main class="overflow-auto p-2">`)。
- `RequestsWorkbench.tsx`:`<div flex h-full>` 左(`w-[38%]` LiveLane+HistoryList)右(`flex-1` DetailPanel) + 挂 `useLiveRequests()`。
- `HistoryList.selectRow(id)` = `dispatch({kind:"select",id})` + `navigate('/requests/'+id)`(**导航已存在**);`selected={e.id===useParams().id}`。
- `LiveLane.tsx`:行用 `RequestRow`,**当前无 onClick/导航**(需补)。`RequestRow` props 已含 `onClick?`。
- `list-store.ts`:有 `selectedId: string|null`(`select` action 设),拆分后列表页无 `:id` param → 粘滞高亮改读 `selectedId`。
- `DetailPanel.tsx`:`useParams().id` → `useEntry(id)` → `DiagnosticBar` + `[DetailSubRail | segment 内容(overflow-auto p-2)]`。无 id 时显"← 选一条"占位(分离后详情页恒有 id,该占位移到列表页空选态/无意义)。
- `ConvoSegment.tsx`:system(走 SystemMessage)+ `<ConversationView messages={inboundRequest.messages}/>`。
- `StagesSegment.tsx`:inbound↔effective diff 切换 + `@container` 三腿并排(Inbound/Effective/Wire,各 `RequestLegBody` → ConversationView 或 JSON pre)。
- `ConversationView.tsx`:`messages.map((m,i)=><MessageBlock message={m}/>)` **扁平、无 id/锚点**。`MessageBlock` = role 标签 + `<ContentRenderer blocks={normalizeToContentBlocks(message)}/>`。
- 测试:`tests/DetailPanel.vitest.test.tsx` 引 DetailPanel;**无 Workbench 测试**(删除安全)。

## 风格 / 约定(每个 subagent 必带)
- bun-first:验证 `bun run --filter copilot-api-ui-v4 {typecheck,test:bun,test:vitest,build}`。不用分号、三元行首、严格 TS 避免 `any`、无 `React.FC`、无 `dangerouslySetInnerHTML`、`eslint --fix` 格式化。
- 测试:纯逻辑 `tests/*.bun.test.ts`、组件 `tests/*.vitest.test.tsx`(ui-v4 测试全在扁平 `tests/`)。组件在 `src/components/...`。
- 类型 single-source(后端经 `~backend/*` re-export,不前端重定义)。
- 裁判轴:**长远正确 + 范围内完整**,非 ROI/YAGNI/工期。subagent 不碰 git(controller 按精确 pathspec 提交,并发后端会话不可裹入)。

---

## Task 1 — 页面分离(两路由全屏)

**(1) `src/components/requests/RequestsListPage.tsx`**(新):列表全屏 —— 挂 `useLiveRequests()`,渲 `<div flex h-full min-h-0 flex-col>` 含 `<LiveLane/>` + `<HistoryList/>`(占满宽高,无详情)。即把 Workbench 的左列提为整页。

**(2) `src/components/requests/RequestDetailPage.tsx`**(新):详情全屏 —— 顶部返回条 `<button onClick={()=>navigate('/requests')}>‹ 返回列表</button>`(mono 小号,沿用按钮 idiom)+ `<DetailPanel/>`(占满)。`<div flex h-full min-h-0 flex-col>`。

**(3) `src/App.tsx`**:`requests` → `<RequestsListPage/>`,`requests/:id` → `<RequestDetailPage/>`。删 `RequestsWorkbench` import。

**(4) `LiveLane.tsx`**:行加导航 —— `const navigate=useNavigate()`,`<RequestRow ... onClick={()=>navigate('/requests/'+r.id)}/>`(live 行也可点进详情)。

**(5) `HistoryList.tsx`**:粘滞高亮改读 list-store `selectedId`(列表页无 `:id` param)——`const selectedId=useListStore(s=>s.selectedId)`,`selected={e.id===selectedId}`。`selectRow` 不变(已 navigate)。

**(6) 退役 `RequestsWorkbench.tsx`**:两路由不再用 → `git rm`(controller 做;tracked+committed、无 Workbench 测试,安全)。**注**:subagent 不删 git,只在报告里标明该文件可删,controller `git rm`。

**(7) 测试** `tests/request-pages.vitest.test.tsx`:`RequestsListPage` 渲出 Live + History 区(无 DetailPanel);`RequestDetailPage` 渲返回按钮 + DetailPanel;用 `MemoryRouter`(`react-router-dom`)包裹注入路由。LiveLane 行 onClick 导航可断言(fireEvent + 路由变化或 mock navigate)。沿用 `tests/DetailPanel.vitest.test.tsx` 的 router 包裹模式。

**验收**:typecheck/test:vitest/build 绿;`/requests` 仅列表全宽、`/requests/:id` 仅详情全宽 + 返回;点行(Live/History)进详情、返回回列表;深链直达详情。

---

## Task 2 — DetailTocTree 组件 + buildMessageTocNodes 纯 builder(TDD)

**(1) `src/lib/content/toc.ts`**(新,纯逻辑):
- `interface TocNode { label: string; anchorId: string; kind: string; children?: Array<TocNode> }`。
- `buildMessageTocNodes(messages: Array<MessageContent>, anchorPrefix: string): Array<TocNode>`:每条消息 → 一个节点 `{ label: \`${role} · ${preview}\`, anchorId: \`${anchorPrefix}-msg-${i}\`, kind: role, children: 块节点 }`;块子节点 `{ label: blockLabel(block), anchorId: \`${anchorPrefix}-msg-${i}-blk-${j}\`, kind: block.type }`,块经 `normalizeToContentBlocks(message)` 得(与渲染同源,锚点对齐)。`blockLabel`:text→文本前 ~40 字预览;tool_use→`tool_use: {name}`;tool_result→`tool_result`;thinking→`thinking`;image→`image`;其它→type。preview 取 message 文本前 ~40 字。
- 纯函数,无 React。

**(2) `src/components/detail/toc/DetailTocTree.tsx`**(新):
- props `{ nodes: Array<TocNode>; onSelect: (anchorId: string) => void; activeAnchor?: string }`。
- 渲可折叠树:每节点一行(缩进按深度),有 children 时前置 ▸/▾ 折叠钮(local `useState` 折叠集,或每节点自管),点节点 label → `onSelect(anchorId)`。`activeAnchor===anchorId` 高亮(primary 色)。mono 小号、kind→色(可借 role 色/block 色,轻量即可)。
- 块子节点默认折叠(只显消息层),展开看块。深度 ≤2(消息→块);Stages 用时会包一层 leg(深度 3),组件须支持任意深度递归渲染。

**(3) 测试**:`tests/toc-builder.bun.test.ts`(纯)——`buildMessageTocNodes` 对含 text/tool_use/thinking 的消息产正确 anchorId + label + children;`tests/DetailTocTree.vitest.test.tsx`——渲树、点节点触发 onSelect(anchorId)、折叠展开切换、activeAnchor 高亮。

**验收**:test:bun + test:vitest + typecheck 绿;builder anchorId 方案与 Task 3 渲染端一致。

---

## Task 3 — 锚点 threading + scroll/highlight + 接 Convo 段

**(1) ConversationView/MessageBlock 加 `anchorPrefix`**:
- `ConversationView` 加 `anchorPrefix?: string`;有则每条消息外层 `<div id={\`${anchorPrefix}-msg-${i}\`}>`,并把 `anchorPrefix`+`index` 传 MessageBlock 以渲块级 id。
- `MessageBlock` 加可选 `anchorPrefix?: string; messageIndex?: number`;有则每块外层渲 `id={\`${anchorPrefix}-msg-${i}-blk-${j}\`}`(在 ContentRenderer 的 block 映射处,或 MessageBlock 包一层)。**锚点 id 必须与 Task 2 builder 完全一致**。
- 无 anchorPrefix 时行为不变(向后兼容,Stages 旧路径/其它消费者不受影响)。

**(2) `src/hooks/useAnchorScroll.ts`**(新):`useAnchorScroll()` 返回 `(anchorId) => void` —— `document.getElementById(anchorId)?.scrollIntoView({block:"start",behavior:"smooth"})` + 给该元素加瞬时高亮 class(如 ring,~1.2s 后移除,用 setTimeout + cleanup)。可同时维护 `activeAnchor` state 供 TOC 高亮。

**(3) `ConvoSegment.tsx` 接 TOC**:布局改 `<div flex gap-2>` —— 左 `<nav class="sticky top-0 w-[200px] shrink-0 ...">` 渲 `<DetailTocTree nodes={buildMessageTocNodes(inboundRequest.messages, "convo")} onSelect={scrollTo} activeAnchor={...}/>`,右 `<div flex-1 min-w-0>` 渲 system(SystemMessage 不变)+ `<ConversationView messages={inboundRequest.messages} anchorPrefix="convo"/>`。sticky 相对 DetailPanel 的 overflow-auto 容器生效。messages 为空时 TOC 不渲(或显空)。

**(4) 测试** `tests/ConvoSegment.vitest.test.tsx`(或扩 segments 测试):TOC 树渲出消息节点;点节点调用 scroll(可 mock scrollIntoView 断言被调 + anchorId);ConversationView 渲出匹配 id 的锚点元素。

**验收**:test:vitest + typecheck + build 绿;Convo 段左 TOC 右内容,点跳转(scrollIntoView 被调),锚点 id 双向一致。

---

## Task 4 — 接 Stages 段(leg → message 树 + 跨腿锚点)

**(1) `StagesSegment.tsx` 接 TOC**:在三腿并排上方或左侧加 TOC —— 构建 leg→message 树:顶层 3 个 leg 节点(Inbound/Effective/Wire,各 `{label, anchorId: \`stage-${legKey}\`, children: buildMessageTocNodes(legMessages, \`stage-${legKey}\`)}`),`<DetailTocTree>` 渲。布局:`<div flex gap-2>` 左 `<nav sticky w-[200px]>` TOC,右 `<div flex-1 min-w-0>` 现有 `@container` 三腿并排。
- 各 leg 的 `RequestLegBody`/`ConversationView` 传 `anchorPrefix={\`stage-${legKey}\`}`(legKey ∈ inbound/effective/wire),使每腿消息/块 id 唯一且与 TOC 对齐。点 leg 节点滚到该腿顶、点 message 节点滚到该腿对应消息。
- diff 切换(inbound↔effective)保留在 TOC 右侧内容区上方(不进 TOC)。leg 缺失(effective/outbound 无)则该 leg TOC 节点不渲。

**(2) 测试** `tests/StagesSegment.vitest.test.tsx`(扩):TOC 渲出 3 leg 节点 + 各 leg 消息子节点;锚点 id 形如 `stage-inbound-msg-0`;点跳转。

**验收**:test:vitest + typecheck + build 绿;Stages 左 TOC(leg→消息)右三腿并排,跨腿锚点唯一、点跳转正确;窄容器三腿退单列仍可用。

---

## Task 5 — 验证 + 文档回填

- 全量:`bun run --filter copilot-api-ui-v4 {typecheck,test:bun,test:vitest,build}` 全绿;`find ui-v4/node_modules node_modules -name binding.gyp` 空。
- `git rm` 退役的 `RequestsWorkbench.tsx`(controller 做)。
- 回填 `ui-v4/README.md` 现状 + `ui-v4/docs/HANDOFF.md`(Plan 08:页面分离 + TOC 树)。
- DESIGN §4 主从一体已被用户决策反转 → 在 DESIGN §4 加落地态注记(主从一体改为两路由全屏分离,2026-06-24 用户定)或在 README 现状说明(DESIGN 是设计稿,现状以 README 为准,按 completion-includes-doc-sync 判断)。

## 验收(整体)
- `/requests` 列表全屏、`/requests/:id` 详情全屏 + 返回、点行(Live/History)进详情、深链直达;Convo/Stages 左 TOC 树(消息→块 / leg→消息)右内容,点节点滚动跳转 + 瞬时高亮,锚点 id 双向一致;全套件绿、零 binding.gyp。

## 暂缓
- TOC scroll-spy(IntersectionObserver 跟随滚动自动高亮当前节点)——本轮只做 click-to-jump + click 高亮,scroll-spy 留后续。
- Response/Headers/Meta 段的 TOC(本轮只 Convo/Stages,用户明确点名这两段)。
- 列表/详情间的过渡动画。

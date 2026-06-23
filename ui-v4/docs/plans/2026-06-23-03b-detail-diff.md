# ui-v4 Plan 03b — 详情 diff（SSE 帧 / 消息级 / stages 并排）bite-sized 实现计划

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。本文是骨架经 deep-read 后端真实类型 + Plan 03 落地组件展开的 bite-sized 版（取代原 3.9KB 骨架）。

**Goal:** 给 Plan 03 的展示型详情段加 **diff**（DESIGN §4.3 最具诊断价值部分）：① SSE 帧 diff（upstream vs forwarded）② 消息级 inbound↔effective rewrite diff ③ Request stages 并排对比。外加 SystemMessage 独立支路 + tool_result 内嵌块递归。用 **`diff`（jsdiff）** 做叶子词/行 diff、自建领域 aligner（逐字移植 `ui/src/utils/block-diff.ts` 算法核，渲染壳重写成 React）。

## 现状校正（deep-read 实证，骨架与现状的偏差）

- **当前 SubRail 只有 `Convo / Stages / Headers / Meta`（`DetailSubRail.tsx:1`），无 Response 段、无任何 SSE 渲染**（全仓 grep `sseEvents` 仅 `StagesSegment.tsx:59` 一处显示帧计数）。骨架 Task 3「接进 Plan 03 留的 SSE 展示位」前提不成立。
- **修正**：DESIGN §4.3 段表明列 **Response** 段（Upstream/Forwarded + `SseFrameDiff`）。本轮新增 Response 段承载之（Task 3）。Attempts 段不在本计划范围（DESIGN 有但 03b 八任务未含，留后续）。

## 后端数据契约（deep-read `src/lib/history/types.ts`，全部经 `~backend/lib/history/store` barrel 导出）

- `SseEventRecord`（types.ts:134）= `{ offsetMs: number; type: string; raw: string }`。两套 SSE：`entry.sseEvents`（上游原始，types.ts:272）+ `entry.inboundResponse.sseEvents`（客户端实收，`ForwardedResponse`，types.ts:147/155）。
- 消息级 diff：`entry.inboundRequest.messages`（客户端原始）vs `entry.effectiveRequest?.messages`（`RequestLegData.messages`，types.ts:190/194）。Wire = `entry.outboundRequest?.messages`。
- `MessageContent` 形状（旧 block-diff `messageText` 依赖）：有 `.role: string` 与 `.content`（string | block[]）+ OpenAI `.tool_calls`。ui-v4 已 re-export 进 `@/lib/content/types`。
- `SystemBlock`（types.ts:178）= `{ type:"text"; text:string; cache_control?:{type:string}|null }`。原始 system = `entry.inboundRequest.system`，改写后 = `entry.effectiveRequest?.system`（皆 `string | SystemBlock[]`）。
- Headers 四腿：`entry.httpHeaders.{inboundRequest,outboundRequest,outboundResponse,inboundResponse}`（`Record<string,string>`）。

## ui-v4 现状锚点（要改/复用的真实文件）

- `src/lib/content/{types,normalize}.ts` — `MessageContent`/`ContentBlock` re-export + 类型守卫 `isTextBlock`…`isToolResultBlock`（normalize.ts:13-36）+ `normalizeToContentBlocks`（:59）。
- `src/components/detail/ContentRenderer.tsx` — 纯分发器（按 block.type 选组件，每块包 `ErrorBoundary`）。
- `src/components/detail/MessageBlock.tsx` — `normalizeToContentBlocks(message)` → ContentRenderer，role 色 `ROLE_COLOR`。
- `src/components/detail/blocks/ToolResultBlock.tsx` — 当前把 `block.content` 一律 `JSON.stringify`（Task 7 改递归）。
- `src/components/detail/segments/{ConvoSegment,StagesSegment,HeadersSegment,MetaSegment}.tsx` + `DetailSubRail.tsx` + `DetailPanel.tsx`（段路由 `segment === "X" ? <Seg/> : null`）。
- `src/styles/theme.css` 色 token：`--color-bg #141210` / `--color-surface #16161a` / `--color-border #2a2a32` / `--color-text` / `--color-muted #8a7a55` / `--color-primary #d4a04a`(amber) / `--color-ok #7fd99a`(green) / `--color-warn #d4a04a`(amber) / `--color-fail #e08a8a`(red)。**diff 色映射（钉死）**：`added`→`--color-ok`、`removed`→`--color-fail`、`modified`→`--color-warn`、`same`→`--color-muted`。无专用 diff 色，勿造新 token。

## 风格 / 工具约定（每个 subagent 必带）

- bun-first：装依赖 `bun add --filter copilot-api-ui-v4 diff @types/diff`（`diff@9` 已在根 hoisted，但按 DESIGN §2 须声明进 `ui-v4/package.json`，**不依赖根**）。验证全走 `bun run --filter copilot-api-ui-v4 {typecheck,test:bun,test:vitest,build}`。
- 不用分号；三元放行首；严格 TS 避免 `any`；`eslint --fix` 格式化（非 prettier）。Tailwind v4，class 风格沿用现状（`mono` + `text-[Npx]` + `text-[var(--color-...)]`）。
- 测试双 runner 按后缀互斥：纯逻辑 `*.bun.test.ts`（bun，无 DOM）；组件 `*.vitest.test.tsx`（vitest+jsdom+RTL）。
- 类型 single-source：新类型若需要在后端定义经 `~backend/*` re-export，**不在前端重定义**（本计划无需新后端类型）。
- 裁判轴：**长远正确 + 范围内完整**，不是 ROI/YAGNI/工期/改动量。

---

## Task 1 — deps + 类型 re-export + 移植 block-diff.ts（TDD 纯逻辑，bun test）

**装依赖**：`bun add --filter copilot-api-ui-v4 diff @types/diff`。

**类型 re-export**：`src/types/index.ts` 的 `export type {…}` 块补 `SseEventRecord`、`SystemBlock`、`ForwardedResponse`、`RequestLegData`（来源 `~backend/lib/history/store`，已导出）。

**移植** `ui/src/utils/block-diff.ts` → `src/lib/diff/block-diff.ts`，**逐字保留算法核**（`diffText`/`diffLinesRich`/`alignWithModified`/`messageText`/`diffMessageList`/`diffStats`/`diffSseFrames` + 全部 interface），仅调整 import：
- `MessageContent` 从 `@/lib/content/types` import（旧版从 `@/types`）。
- `SseEventRecord` 从 `@/types` import（Task 1 已 re-export）。
- `from "diff"` 不变。

**测试** `src/lib/diff/block-diff.bun.test.ts`（AAA，穷尽）：
- `diffText("foo bar","foo baz")` → 词级 part 标 added/removed。
- `alignWithModified` 四 kind：纯 same / 纯 added（right 多）/ 纯 removed（left 多）/ modified（同 groupOf 相邻 removed→added 配对）。构造最小数组 + keyOf/groupOf 显式验证。
- `diffMessageList`：同 role 内容改 → `modified` 带 `textDiff`；增删 role → added/removed。
- `diffSseFrames`：同 type 不同 raw → `modified` 带 `rawDiff`；upstream 有 forwarded 无 → `removed`(dropped)；反之 `added`。
- `diffLinesRich`：配对 del→add 行级 + 行内词高亮；纯增/纯删；oldNo/newNo gutter 编号正确。
- `diffStats` 计数。

**验收**：`test:bun` 绿、`typecheck` 绿、零 `binding.gyp`（`find ui-v4/node_modules node_modules -name binding.gyp` 空）。

---

## Task 2 — DiffView / InlineParts 渲染原语（vitest 组件）

`src/components/detail/diff/InlineParts.tsx`：消费 `Array<InlineDiffPart>`，逐 part `<span>`——`added` 底色 `--color-ok`/22%，`removed` 底色 `--color-fail`/22% + line-through，普通原样。供 Sse/Message diff 行内高亮复用（DRY，single-source）。

`src/components/detail/diff/DiffRow.tsx`（或 DiffView）：通用一行渲染——`sign`（`= ~ − +` 按 kind）+ 色（钉死映射）+ type/role 列 + body（`modified` 走 InlineParts，否则纯文本预览）。Sse/Message 两视图共享此行壳，避免三处漂移。

**测试** `*.vitest.test.tsx`：渲染含 added/removed part 的 InlineParts，断言对应 span 带高亮 class/style；DiffRow 四 kind 渲染正确 sign + 色。

**验收**：`test:vitest` 绿、`typecheck` 绿。

---

## Task 3 — SseFrameDiff + 新增 Response 段 + 接 sub-rail

`src/components/detail/diff/SseFrameDiff.tsx`（移植 `ui/src/components/detail/SseFrameDiff.vue` 渲染壳逻辑，**保留 cap 守卫**）：
- props `{ upstream: SseEventRecord[]; forwarded: SseEventRecord[] }`。
- `MAX_INPUT=4000`（超则 oversized 不 diff、提示开 Raw）、`MAX_ROWS=400`（超则 `+N more`）。`diffSseFrames` → `diffStats`。
- 每行 `[sign] [type] [body]` grid，body `modified` 走 InlineParts（`row.rawDiff`）否则 `(row.forwarded ?? row.upstream)?.raw` 单行省略。badge `~N −N +N`。

**新增 `src/components/detail/segments/ResponseSegment.tsx`**（DESIGN §4.3 Response 段）：
- **Upstream**：`entry.outboundResponse.content` 走 `<MessageBlock>`（无则 rawBody/error）+ 折叠列出 `entry.sseEvents`（上游原始帧，offsetMs/type/raw 单行）。
- **Forwarded**：`entry.inboundResponse.content`（JSON）或 `entry.inboundResponse.sseEvents` 帧列。
- **SseFrameDiff**：`upstream={entry.sseEvents ?? []}` `forwarded={entry.inboundResponse?.sseEvents ?? []}`，二者皆空则不渲染 diff。

**接线**：`DetailSubRail.tsx` 的 `SEGMENTS` 加 `"Response"`（置于 `Stages` 与 `Headers` 之间）；`DetailPanel.tsx` 加 `segment === "Response" ? <ResponseSegment entry={data}/> : null`。

**测试** `ResponseSegment`/`SseFrameDiff` vitest：构造 upstream/forwarded 帧（含 modified/dropped/added），断言 diff 行 + stats badge；oversized 阈值提示。

**验收**：`test:vitest`+`typecheck`+`build` 绿；手动详情见 Response 段 + 帧 diff。

---

## Task 4 — MessageDiffView + Convo/Stages 接 inbound↔effective diff

`src/components/detail/diff/MessageDiffView.tsx`（移植 `MessageDiffView.vue`）：props `{ left: MessageContent[]; right: MessageContent[] }`，`diffMessageList` → 行（复用 Task 2 DiffRow）；`MAX_ROWS=400` cap；summary `~N −N +N · M unchanged`；`preview()` 截 160 字。

**接线**：`StagesSegment.tsx` 顶部加「diff」切换（local `useState`）——开启时在 Inbound/Effective 之间插入 `<MessageDiffView left={inboundRequest.messages} right={effectiveRequest.messages}/>`（仅当 `effectiveRequest?.messages` 存在）。`ConvoSegment` 可加「↔ effective」入口跳同一 diff（视实现简洁度，至少 Stages 有）。

**测试**：MessageDiffView vitest（modified 带词 diff、增删行）。

**验收**：`test:vitest`+`typecheck` 绿；手动 inbound↔effective diff 可见。

---

## Task 5 — Stages Inbound│Effective│Wire 并排（响应式）

`StagesSegment.tsx` 改：三请求腿（Inbound/Effective/Wire）支持 **并排列**（DESIGN §4.3 + §8 响应式）——
- 宽屏（CSS grid `grid-cols-3` 或 `@container`/`min-width` 媒体）三列并排；窄屏退单列堆叠（沿用现 `LegShell` 竖排）。
- 用 Tailwind v4 响应断点（`lg:grid-cols-3` 等）或容器查询；differ 高亮可复用 DiffView（按需，非强制三列都 diff）。
- 保留现有 Upstream/Forwarded 腿（移入 Response 段后 Stages 只剩请求三腿 + 指向 Response 的提示；或 Stages 专注请求三腿，Upstream/Forwarded 归 Response 段）。**决策**：Stages = 请求三腿并排；响应两腿迁 Response 段（Task 3 已建），消除重复。

**测试**：vitest 渲染三腿存在；窄/宽 class 切换（jsdom 无真实布局，断言 class 即可）。

**验收**：`test:vitest`+`typecheck`+`build` 绿；手动宽屏三列、窄屏单列。

---

## Task 6 — SystemMessage 独立支路（标签解析 + original↔rewritten）

`src/components/detail/blocks/SystemMessage.tsx`（移植 `ui/src/components/message/SystemMessage.vue` 核心，React 化）：
- props `{ system: string | SystemBlock[]; rewrittenSystem?: string | SystemBlock[] | null }`。
- `systemToText` 拼接、`hasRewrite`/`contentDiffers`、三态切换 `original | rewritten | diff`（local `useState`）；diff 态用 Task 2 DiffView（`diffLinesRich(originalText, rewrittenText)` 或并排）。
- **标签解析过滤**：移植 `ui/src/utils/formatters.ts` 的 system-reminder/ide_opened_file 标签处理为纯函数 `src/lib/content/system-tags.ts`（deep-read formatters 确认正则）；先 deep-read 再实现。
- **ConvoSegment 改**：`system` 改走 `<SystemMessage system={entry.inboundRequest.system} rewrittenSystem={entry.effectiveRequest?.system}/>`（取代当前 inline JSON.stringify）。

**测试**：system-tags 纯函数 bun test（标签剥离）；SystemMessage vitest（三态切换、contentDiffers badge）。

**验收**：`test:bun`+`test:vitest`+`typecheck` 绿；手动 system 标签过滤 + original↔rewritten。

---

## Task 7 — tool_result 内嵌块递归渲染

`ToolResultBlock.tsx` 改：`block.content` 若是 `ContentBlock[]`（数组且元素带 `.type`，如 text/image）→ 递归走 `<ContentRenderer blocks={content}/>` 而非 `JSON.stringify`；string content 仍纯文本；其他（object）保持 JSON dump。用类型守卫判别（Array.isArray + 元素 `typeof === "object" && "type" in`）。注意避免与 ContentRenderer 的循环 import（ToolResultBlock 已被 ContentRenderer 引，反向引会成环——用动态结构或把递归判断放 ContentRenderer 侧；deep-read 确认 import 方向后定，优先无环方案如在 ContentRenderer 内特判）。

**测试**：vitest——tool_result content 为 `[{type:"text",text:"x"}]` 时渲染出 TextBlock（非 JSON 文本）；string content 仍纯文本。

**验收**：`test:vitest`+`typecheck` 绿；无 import 环（build 绿）。

---

## Task 8 — 验证 + 文档回填

- 全量验证：`bun run --filter copilot-api-ui-v4 {typecheck,test:bun,test:vitest,build}` 全绿；`find ui-v4/node_modules node_modules -name binding.gyp` 空。
- 回填 `ui-v4/README.md` 现状段（加 Plan 03b：详情 diff + Response 段 + SystemMessage + tool_result 递归）。
- 若 IA 有实质变化（新增 Response 段）→ 视需要在 `ui-v4/docs/DESIGN.md` §4.3 标注落地态（DESIGN 是设计稿，落地态以 README 为主，按 completion-includes-doc-sync 判断）。

## 验收（整体）
- block-diff 纯逻辑测试覆盖对齐 + 词级；typecheck/test:bun/test:vitest/build 全绿；零 binding.gyp。
- 手动：详情看 upstream vs forwarded 帧 diff（Response 段）、inbound↔effective 消息 diff（Stages）、Request stages 三腿并排、system 标签解析 + original↔rewritten、tool_result 内嵌块递归。

## 暂缓
- web_search 旁路的 diff（legacy 路径，不经 driver）。
- Attempts 段 per-attempt wire diff（DESIGN §4.3 有，本计划不含，留后续）。
- 请求内搜索高亮联动 diff 段（Plan 04 范畴）。

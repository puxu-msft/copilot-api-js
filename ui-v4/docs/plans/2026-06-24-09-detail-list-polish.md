# ui-v4 Plan 09 — 详情/列表打磨（行统计 + 行号 + 语法高亮 + TOC 美化 + 后端字节/成本）

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。用户 2026-06-24 两条诉求:① 请求列表行信息太少,加统计(参照 TUI 那几项)② 详情 TOC 树不够美观、文本块要行号 gutter、代码/JSON 块要完善语法高亮。用户拍板:**highlight.js** 高亮 + **加后端字节+成本**。

**Goal:**
- **A 列表行丰富**:RequestRow 从 state/model/dur → oracle 列集(time/endpoint/model/state/dur/↑in/↓out/cacheRead/preview/attempt + 慢/缓存未命中异常高亮)。
- **B 行号 gutter**:文本/pre 块每行左侧行号(移植旧 `LineNumberPre`,纯 CSS)。
- **C 语法高亮**:JSON 块(tool input/payload/generic)+ 代码块用 **highlight.js**(amber 主题),与行号组合。
- **D TOC 树美化**:`DetailTocTree` 视觉精修(树引导线/kind 色/hover/active)。
- **E 后端字节+成本**:entries_v2 持久化 `request_bytes`/`response_bytes`/`multiplier`,EntrySummary 投影 → 行展示 ↑req ↓resp + (Nx)/cost(亦解锁 Overview/Sessions cost 留位)。

## 现状锚点（deep-read 实证）

**列表/行**:
- `RequestRow.tsx`:props `{state,model?,durationMs?,selected?,live?,onClick?}`,仅显 `[state] [model] [dur]`。**未用 previewText/tokens/time/endpoint**。
- `HistoryList.tsx`:`entries.map(e => <RequestRow state model durationMs selected onClick/>)`——只传 3 字段。`useHistoryInfinite` 给 `EntrySummary[]`。
- `LiveLane.tsx`:`ActiveRequestInfo`(`{id,endpoint,rawPath?,state,startTime,durationMs,model?,stream?,attemptCount?,currentStrategy?,queueWaitMs?}`)——**无 usage/preview**(在飞未终);Live 行只能显子集。
- `EntrySummary`(`~backend/lib/history/store`,deep-read `src/lib/history/types.ts:389`):有 `startedAt/endpoint/rawPath/state/requestModel/responseModel/responseSuccess/responseError/usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}/durationMs/attemptCount/messageCount/previewText/stream`。**无字节/multiplier(Task 5 加)**。
- **oracle 行参照** `ui/src/components/activity/ActivityRow.vue`:status·time·model·endpoint·state·dur·↑in·↓out·cacheRead·preview(非完成行显 `failureSummary`);异常高亮 `rowAnomaly`(slow >60s、cacheMiss:completed+input>20k+无 cacheRead)。helper 在 `ui/src/utils/activity-helpers.ts`(`endpointLabel`/`tokenIn`/`tokenOut`/`tokenCacheRead`/`truncPreview`/`failureSummary`/`rowAnomaly`)——**移植为 ui-v4 纯函数**(领域逻辑,非渲染壳)。
- `ui-v4/src/lib/format.ts`:有 `statusSignal`/`formatDuration`,**无 `formatNumber`/`formatTime`**(需加)。

**详情块/渲染**:
- `blocks/`:`TextBlock`(纯文本)、`ToolUseBlock`(name + `JSON.stringify(input)` in `<pre>`)、`ToolResultBlock`(string/递归/JSON)、`GenericBlock`(JSON dump)、`ThinkingBlock`、`SystemMessage`(LineNumberPre 思路源)、`ImageBlock`。均无行号、无高亮。
- 旧 `ui/src/components/ui/LineNumberPre.vue`:纯 CSS 行号 gutter(split `\n`、line-no + line-content、>500 行截断「Show all」),无依赖——移植为 React。
- **旧 UI 无任何高亮库**(无 shiki/prism/hljs)——highlight.js 是全新引入。
- `DetailTocTree.tsx`(Plan 08):可折叠递归树,当前纯 mono 行 + `bg-[#3a2f1a]` active——"不够美观",精修对象。

**后端字节/成本数据源**(Task 5):
- 字节**从未持久化**:`requestBodySize` 在 `context/request.ts`(get) + codec 设(`codec/anthropic/codec.ts:287`);`responseBodySize` = `entry.streamBytesIn`(console sink `sinks/console.ts:278-279` 实证)。二者只喂 console log line。
- multiplier:`billing?.multiplier` = `state.modelIndex.get(model)?.billing?.multiplier`,context finalize 期已解析(`context/request.ts:170-184`、`activity-summary.ts:100-114`)。**DESIGN §12 用户已定「写时持久化 multiplier」**(历史定价保真)。
- EntrySummary 投影:`src/lib/history/sqlite/read.ts:158` `rowToSummary(r: SummaryRow)` 从 head 列 `r.*` 组装。写:`src/lib/history/sqlite/serialize.ts:151-164` head 行(`duration_ms`/`message_count`/`preview_text` 等)。
- 加字节/multiplier 须:① entries_v2 加 3 列(additive nullable)② serialize 写路径取 ctx/entry 的 requestBodySize/responseBodySize/multiplier(需确认 finalize 期这些在 HistoryEntry 上还是 ctx 上——deep-read `serialize.ts` 的 `insertCompletedEntry` 签名 + 调用点)③ `SummaryRow` 加列 + `rowToSummary` 投影 ④ `EntrySummary`(+ 可能 `HistoryEntry`)加字段 ⑤ 守卫:**加 leg/列须同步**(参照 DESIGN 后端"加 leg 字段须同步 history sink 显式字段投影")。

## 约定（每个 subagent 必带）
- bun-first:FE 验证 `bun run --filter copilot-api-ui-v4 {typecheck,test:bun,test:vitest,build}`;BE(Task 5)验证 `bun run typecheck` + `bun run test:backend`(**非 npm**)。highlight.js 纯 JS 无 node-gyp(`find ... binding.gyp` 应空)。
- 不用分号、三元行首、严格 TS 避免 `any`、无 `React.FC`、无 `dangerouslySetInnerHTML`(highlight.js 输出须经受控渲染:用 `hljs.highlight` 得 tokens 自渲染,或 **react 安全方式**——见 Task 3)、`eslint --fix`。
- 类型 single-source:EntrySummary 字段后端定义、前端 `~backend/*` re-export。
- **Task 5 并发隔离**:另有会话改 `src/lib/request-telemetry.ts`+`metrics-exposition.ts`——本任务只碰 `src/lib/history/*` + `src/lib/context/*`(若需),**绝不**碰 telemetry 文件;每 commit `git diff --cached --stat` 复核。
- 裁判轴:**长远正确 + 范围内完整**,非 ROI/YAGNI/工期。

---

## Task 1 — 列表行丰富（FE，现有字段）

**(1) `ui-v4/src/lib/format.ts` 加** `formatNumber(n)`(1234→"1.2k"/千分位,镜像旧 `formatNumber`)+ `formatTime(ts)`(epoch→`HH:MM:SS`)。

**(2) `ui-v4/src/lib/activity-row.ts`**(新,纯函数,移植 `ui/src/utils/activity-helpers.ts` 领域逻辑):`endpointLabel(entry)`、`tokenIn/tokenOut/tokenCacheRead(entry)`(`-` 当无 usage)、`truncPreview(entry)`、`failureSummary(entry)`(非完成行结构化失败归因)、`rowAnomaly(entry)→{slow,cacheMiss}`。入参 `EntrySummary`。bun 测试。

**(3) `RequestRow.tsx` 重构**:支持富列。两条用法——History 传完整 `EntrySummary`(richest),Live 传子集。建议 props 改 `{ entry?: EntrySummary; live?: {state,model?,durationMs?,attemptCount?,stream?}; selected?; onClick? }` 或保留标量 props + 增可选富字段(实现者择优,避免 `any`)。布局(全宽列表、mono、dense、工业风):`[● state] HH:MM:SS  model  endpoint  ↑in ↓out (cacheRead)  ×N(attempt>1)  dur   preview…(flex-1 truncate)`;非完成行 preview 位显 `failureSummary`(红);异常高亮(slow→dur 琥珀、cacheMiss→cacheRead 琥珀)。Live 行(无 usage)显 `[◐ state] model … dur`(子集)。

**(4) `HistoryList.tsx`/`LiveLane.tsx`**:History 传 `entry={e}`;Live 传子集。

**(5) 测试**:activity-row bun 纯测试;RequestRow vitest(富行渲染 token/preview/time、异常高亮、Live 子集)。

**验收**:test:bun+test:vitest+typecheck+build 绿;列表行显著丰富。

---

## Task 2 — LineNumberedText 行号 gutter（FE）

**`ui-v4/src/components/detail/LineNumberedText.tsx`**(新,移植 `LineNumberPre.vue` 纯 CSS 思路):props `{ text: string; className? }`。split `\n`、左 gutter 行号(CSS counter 或显式 span,右对齐 dim)、右内容(`whitespace-pre`)。>500 行截断 + 「显示全部 N 行」。**React 安全**:文本作 children(自动转义),不 v-html。供 TextBlock/pre 类块复用。Task 3 的高亮版在此之上叠加(行号 + 高亮 tokens)。vitest(行号渲染、截断)。

**应用**:`TextBlock`(长文本走 LineNumberedText)、可选 `GenericBlock`/`ToolResultBlock` 的 JSON pre(Task 3 合并高亮时统一)。

**验收**:test:vitest+typecheck 绿;文本块带行号。

---

## Task 3 — highlight.js 语法高亮（FE，amber 主题）

**(1) 装依赖** `bun add --filter copilot-api-ui-v4 highlight.js`(纯 JS,声明进 `ui-v4/package.json`)。**按需引语言**:`json`/`bash`/`typescript`/`xml`(只注册用到的,减体积)。
**(2) `ui-v4/src/components/detail/CodeBlock.tsx`**(新):props `{ code: string; lang?: string }`。用 `hljs.highlight(code,{language})` 得高亮 HTML/tokens,**受控渲染**——优先 `hljs` 输出 token spans 经 React 渲染(若用 `dangerouslySetInnerHTML` 须确认 hljs 输出已 HTML-escape 文本节点、仅注入 span class,且 lang 白名单;否则改 token 流自渲染)。与 **LineNumberedText 组合**:行号 gutter + 每行高亮。amber 主题 CSS 在 `src/styles/theme.css`(hljs class → CSS vars 配色:string/number/key/keyword/comment 等,贴 Terminal Amber)。
**(3) 应用**:`ToolUseBlock`(input JSON→`<CodeBlock lang="json">`)、`GenericBlock`、`ToolResultBlock`(JSON 分支)、payload pre(StagesSegment JSON fallback)。text 块的代码 fence(可选,markdown 范畴——本轮至少 JSON 全覆盖)。
**(4) 测试**:CodeBlock vitest(JSON 渲染出高亮 token class、行号);零 binding.gyp 审计。

**验收**:test:vitest+typecheck+build 绿;零 binding.gyp;JSON/代码块高亮 + 行号。

---

## Task 4 — DetailTocTree 视觉美化（FE）

`DetailTocTree.tsx` 精修(不改 onSelect/折叠/activeAnchor 契约):树引导竖线(深度缩进的 hairline)、kind→色(role 色 user/assistant、block 色 tool_use/thinking/text)、▸/▾ 旋转过渡、hover 态、active 更精致(左 accent 条 + 柔背景非纯块)、密度/字号微调。纯 CSS/Tailwind 无依赖。保留所有现有测试绿(锚点/onSelect/折叠不变)。vitest 若断言具体 class 需同步。

**验收**:test:vitest+typecheck+build 绿;TOC 明显更精致;Plan 08 既有 TOC 测试不破。

---

## Task 5 — 后端持久化 request_bytes / response_bytes / multiplier（BE）

**deep-read** `serialize.ts`(`insertCompletedEntry` 签名 + head 行组装 + 调用点拿 ctx)、`read.ts`(`SummaryRow`+`rowToSummary`)、`types.ts`(EntrySummary/HistoryEntry)、entries_v2 schema(migration/CREATE 处)、context finalize 期 requestBodySize/responseBodySize(streamBytesIn)/billing.multiplier 可达性。
- **schema**:entries_v2 加 `request_bytes INTEGER`/`response_bytes INTEGER`/`multiplier REAL`(additive nullable,旧行 NULL→前端显 `—`)。**确认 migration 机制**(ALTER 或 CREATE-if-not-exists 列检测)。
- **写**:finalize 把 requestBodySize / responseBodySize(=streamBytesIn)/ billing.multiplier 写进 head 行(三者来源 deep-read 确认;若不在 HistoryEntry 上须先注入)。
- **读**:`SummaryRow` 加 3 列、`rowToSummary` 投影 `requestBytes?`/`responseBytes?`/`multiplier?`。
- **类型**:`EntrySummary` 加 `requestBytes?:number`/`responseBytes?:number`/`multiplier?:number`(+ 视需要 `HistoryEntry`)。前端 re-export 自动可见。
- **守卫**:加列须同步任何「显式字段投影」处(history sink onTerminal 等,grep 确认);L1/round-trip 守卫测试若枚举字段须更新。
- **并发隔离**:**只碰 `src/lib/history/*`(+ 必要的 `src/lib/context/*`),绝不碰 telemetry 文件**。
- **测试**:serialize/read round-trip(写入 bytes/multiplier→读回 EntrySummary)、旧行无列→undefined、`bun run test:backend` 相关域绿。

**验收**:`bun run typecheck` + `bun run test:backend` 绿;EntrySummary 携带 bytes/multiplier;并发文件零裹入。

---

## Task 6 — 行内接入 字节 + 成本（FE）

Task 5 后,`RequestRow`/activity-row 加:`↑${formatBytes(requestBytes)} ↓${formatBytes(responseBytes)}`(无则省)、`(${multiplier}x)` 计费徽 + 可选 cost=`(input+output)×multiplier`(formatNumber)。`formatBytes` 加进 `format.ts`。Live 行无这些(在飞)。测试断言字节/multiplier 列。

**验收**:test:vitest+typecheck+build 绿;行显 ↑req ↓resp +(Nx);旧无数据行显 `—` 不崩。

---

## Task 7 — 验证 + 文档回填

- 全量:FE `{typecheck,test:bun,test:vitest,build}` + BE `typecheck,test:backend` 全绿;`find ui-v4/node_modules node_modules -name binding.gyp` 空。
- 回填 `ui-v4/README.md` 现状 + `ui-v4/docs/HANDOFF.md`(Plan 09)。后端字节/成本 EntrySummary 字段记入 `docs/DESIGN.md`(EntrySummary 描述 / history 列表)。
- 若 Overview/Sessions 的 cost 留位现可填(multiplier 已通)→ 视情接入(或记 follow-up)。

## 验收（整体）
- 列表行富含统计(time/endpoint/tokens/cache/preview/attempt/异常 + ↑req↓resp + Nx/cost);文本块行号 gutter;JSON/代码块 highlight.js 高亮(amber);TOC 树美化;后端 bytes/multiplier 持久化+投影;全套件绿、零 binding.gyp、并发零裹入。

## 暂缓
- text 块 markdown 代码 fence 的逐 fence 高亮(本轮至少 JSON 全覆盖,markdown 渲染属后续/Plan 07 视觉打磨范畴)。
- 历史旧行的 bytes/multiplier 回填(additive 列,旧行 NULL,不回迁)。
- 请求内搜索与高亮联动(Plan 04)。

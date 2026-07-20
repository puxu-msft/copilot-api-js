# Spec: ui-v4 请求批量导出 + HTTP status/statusText 捕获 + per-attempt 展示

- 日期: 2026-07-07
- 类型: Spec（what & why + 验收标准；how 交由后续 plan）
- 状态: 草案（已过 2 轮对抗 subagent review + 修订；待用户 review → writing-plans）
- 归属: `docs/spec/`；相关 ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、既有 spec [history-http-header-capture](history-http-header-capture.md) / [entries-v3-per-leg-storage](entries-v3-per-leg-storage.md)

## 1. 背景与动机

三个诉求同源——**让请求的可导出性与可观测性无论成功/失败都完整**（richest-data-flow 在 UI + 捕获两端的补全）。

### 现状（已实证）

- **后端单条导出已完整、与状态无关**: `GET /history/api/entries/:id/export`（[handler.ts](../../src/routes/history/handler.ts) `handleExportEntry`）走 `getEntry` → 最丰富形态（全 stages、每次尝试 sseEvents、每条 leg headers、request_group 展开），`compressAsync`（zstd L3）压缩。completed/failed/aborted/interrupted 都能导出全量。
- **数据模型已完整**: `HistoryEntry`（[types.ts](../../src/lib/history/types.ts)）存 `inboundRequest`/`effectiveRequest`/`outboundRequest`/`outboundResponse`/`inboundResponse`、`httpHeaders`（4 leg + trailers）、顶层 `sseEvents`、`attempts[]` 每次尝试的 `effectiveRequest`/`wireRequest`/`response`/`sseEvents`/`responseHeaders`。`getEntry` 重建后随导出全量落盘（review 已实证）。
- **详情页顶层已能显示**: [DetailPanel](../../ui-v4/src/components/detail/DetailPanel.tsx) 有 Convo/System/Stages/Response/SSE/Headers/Meta 七段——但**只渲染顶层（= 最终尝试）数据**。`grep .attempts ui-v4/src` **零命中**：详情页**完全不渲染 per-attempt 数据**。
- **status 已部分渲染**: [ResponseSegment.tsx:202](../../ui-v4/src/components/detail/segments/ResponseSegment.tsx) **已有** `status {entry.outboundResponse.status ?? "—"}` 行——但成功请求显示 `—`（成功路径不存 status）。
- **单条导出入口只在详情页**: [DiagnosticBar](../../ui-v4/src/components/detail/DiagnosticBar.tsx) 的 `ExportButton`。列表页无导出。

### 三个缺口

- **A（列表批量可导出性）**: 无法在列表页一次导出多条。既有 `GET /api/export`（`handleExport` → `exportHistory`）是**全量 flat json/csv 摘要**，非按选中 id 的 richest `.zst`，不满足需求。
- **B（status 捕获+显示）**: 根因不是漏渲染，而是**上游没接线**：`ResponseData.status`（[context/types.ts](../../src/lib/context/types.ts)）注释明写 *only on error*——**成功请求根本没存 status**（故 ResponseSegment 显示 `—`）；`statusText` 全链路从未捕获；DiagnosticBar 无 status 芯片。
- **C（per-attempt 可视）**: 多次重试的请求，详情页无处看到「每次尝试」各自的 status/请求/响应/头/SSE（数据在、能导出，但 UI 不可视）。

## 2. 目标 / 非目标

### 目标

- A: 列表页加**管理表头 + 行复选 + 批量导出**，选中条目打包为单个 `export.zst`。
- B: 上游 status/statusText **无论成功/失败/aborted 都捕获并持久化**，DiagnosticBar 显示 `HTTP <status> <reason>`、ResponseSegment 既有 status 行补 statusText。
- C: 详情页新建 **per-attempt 展示骨架**，遍历 `attempts[]` 可视每次尝试的 status/effectiveRequest/wireRequest/response/responseHeaders/sseEvents。

### 非目标（本 spec 不做，记录去向）

- 分段/单块就地导出（SSE 原始流、Headers、单次尝试请求各自复制/下载）——用户明确「维持整包 .zst 为主」，暂缓（可入 [deferred-backlog](../todo/deferred-backlog.md)）。
- 「整个筛选结果」批量导出（跨未加载页）——本期只做**当前已加载行**（用户已定）。若后续要，需加按 query 导出的后端变体。
- 管理表头的 delete/pin 批量操作——本期只做 Export，表头结构可扩展但不实现其它动作。
- LiveLane 在途请求纳入多选——**排除**（用户已定；transient，落地后仍可单条导出）。

## 3. 特性 A —— 列表页多选批量导出

### A.1 后端契约（新端点）

`POST /history/api/entries/export`

- 请求 body: `{ ids: string[] }`（JSON）。**为什么 POST 而非 GET**: 选中可达数百条，id 拼进 URL 会超长度上限；body 更干净、无编码坑。
- 处理: 逐 id `getEntry(id)`（richest 形态，覆盖 in-flight 与已落库——review 实证 `getInFlight(id) ?? getEntryById(id)`）。找不到/已被 reaper 淘汰的 id **不静默丢**，收进 `missingIds`（never-throw + richest-data-flow：报告缺失而非假装成功）。
- 响应体（压缩前 JSON）:
  ```jsonc
  {
    "version": 1,
    "exportedAt": 1751846400000,   // Date.now()
    "count": 42,                    // entries.length
    "missingIds": ["abc"],          // 请求了但取不到的 id（可空数组）
    "entries": [ /* HistoryEntry[]，与单条导出同形 */ ]
  }
  ```
  经 `compressAsync(bundle)` → zstd（review 实证 `JSON.stringify(unknown)` 接受该对象）。
- 响应头: `Content-Type: application/zstd`、`Content-Disposition: attachment; filename="export.zst"`。
- 守卫（镜像 `handleExportEntry`）: history 未启用 → 400；body 缺失/`ids` 非数组/空数组 → 400（附可读 message）。
- 注册: [route.ts](../../src/routes/history/route.ts) `historyRoutes.post("/api/entries/export", handleExportBundle)`（review 实证：2 段 POST 与 3 段 `GET /:id/export`、`POST /:id/pin` 无匹配冲突）。

### A.2 前端 UX

- **api 客户端**（[api.ts](../../ui-v4/src/lib/api.ts)）: 新增 `postBlob(path, body)`（POST JSON body → `Blob`，镜像既有 `getBlob` 的错误处理）。
- **选择状态**: 新 `selection-store`（zustand，`Set<string>` 选中 id + 是否在选择模式）。**与 `list-store` 分开**（后者只管 tail/buffer/locate，单一职责；见 [list-store.ts](../../ui-v4/src/stores/list-store.ts)）。切换页面 / go-live 不清空选择（选择是跨滚动的用户意图），提供显式「清空」。
- **行复选**: [RequestRow](../../ui-v4/src/components/requests/RequestRow.tsx) 的 `HistoryRow` 左侧加复选框；勾选切换选中，**行体点击仍进详情**（复选框 `stopPropagation`，两交互不冲突）。`LiveRow` 不加复选框（在途排除）。
- **管理表头**: [HistoryList](../../ui-v4/src/components/requests/HistoryList.tsx) 顶部现有 “History · N total ▶ live/resume” 头扩为管理表头。有选中时显示: 选中数、「全选（当前已加载行）」、「清空」、「导出 .zst」。
  - 全选范围 = **当前已加载进 DOM 的 History 行**（用户已定），不触发 load-until-found。
  - 导出: 收集选中 id → `api.postBlob("/history/api/entries/export", { ids })` → `triggerDownload(blob, "export.zst")`（复用 [export-entry.ts](../../ui-v4/src/lib/export-entry.ts) 的 `triggerDownload`）。
  - 导出中/失败态: 参照 `ExportButton` 的 idle/busy/error 内联反馈（ui-v4 无 toast）。
- **export-entry.ts**: 新增 `downloadEntriesAsZst(ids: string[])`。
- **选中项被 reaper 淘汰**（MINOR）: 导出侧 `missingIds` 已兜底；UI 侧无需主动清理 selection Set（导出后按需清空即可），实现期可选加「淘汰即从 Set 移除」，不阻塞。

### A.3 验收标准（A）

1. 列表勾选 ≥2 条 → 点导出 → 浏览器下载 `export.zst`；解压得 `{ version, exportedAt, count, missingIds, entries }`，`entries` 逐条与各自 `/entries/:id/export` 内容等价（richest 全量）。
2. 选中混含成功/失败/aborted/interrupted → 全部出现在 `entries`，无一因状态被丢。
3. **（新增，MAJOR-D4 oracle）** 选中一个**含 ≥2 次尝试**的 entry → 导出解压后，每个 `attempts[i]` 均含 `effectiveRequest`/`wireRequest`/`response`/`responseHeaders`/`sseEvents`（用独立 `decompress` 断言逐字段，**不**用 `toEqual(getEntry)`——该断言对空 attempts 也通过、会掩盖回归）。
4. 选中一个已被 reaper 淘汰的 id → 该 id 进 `missingIds`，其余正常导出，HTTP 200（不整体失败）。
5. `ids: []` 或非数组 → 400。
6. 行复选框点击不导航；行体点击照常进详情。LiveLane 在途行无复选框。

## 4. 特性 B —— HTTP status + statusText 捕获与顶层显示

### B.1 根因与取向

成功路径不存 status（故 ResponseSegment 显示 `—`）、statusText 全程未捕获、DiagnosticBar 无芯片。按 richest-data-flow（该建非删）+ 无向后兼容负担：**在上游响应捕获点，成功/失败/aborted 都记录 status/statusText**，投影进 history，前端显示。

### B.2 捕获接线面（richest 全链路，已按 review 修正）

上游响应对象的捕获分成功/失败两路，driver（[driver.ts](../../src/lib/pipeline/driver.ts)）在捕获 headers 的两处附近接线：

- **成功路径 status 来源（review 修正 MAJOR-C2）**: transport **不持有** `Response`——`sendUpstreamHttp`（[send.ts](../../src/lib/transport/send.ts)）只返回 SSE generator / 解析后 JSON，`Response` 局限在 `send.ts` 内、`captureHttpHeaders` 只抽 headers。因此须改 **`send.ts`**：扩展 `HeadersCapture`（现 `{ request?, response? }`）或返回形状，把 `response.status` + `response.statusText` 一并surface 出来 → 填入 `UpstreamStream`（[pipeline/types.ts](../../src/lib/pipeline/types.ts)，新增 `status: number` + `statusText: string`）。**upstream-WS 路径无 HTTP status**（review 实证 `responses-transport.ts` 返 `new Headers()`）——status 缺省/省略。
- **失败路径**: `apiError = classifyError(error)`。`HTTPError`（[http-error.ts](../../src/lib/error/http-error.ts)）有 `status` 无 `statusText`——`fromResponse` 从 `response.statusText` 补 `statusText`（review 实证 `fromResponse` 持 live `Response`，可达）；`ApiError`（[classify.ts](../../src/lib/error/classify.ts)）加 `statusText?` 并经 `classifyHTTPError` 透传。网络/abort 无上游响应 → status/statusText 缺席（正确）。**（MINOR-D1）** 实现期核实：有无带 HTTP status 却不走 `HTTPError` 类的失败路径（那会有 status 无 statusText）。
- **记录到 attempt（review 修正 MINOR-C3）**: 成功捕获点（driver ~L278）时 `attempt.response` **尚为 null**（`complete()` 才 `setAttemptResponse`），故**不能**扩展 `setAttemptResponse`。改为给 `Attempt` interface（[context/types.ts:101-127](../../src/lib/context/types.ts)）**新增独立 `status?`/`statusText?` 字段**，driver 在成功（`upstream.status/statusText`）与失败（`apiError.status/statusText`）两处经新 setter（如 `setAttemptResponseMeta`）写入。
- **合并进顶层 `_response`（review 修正 MINOR-C5 + MAJOR-D3）**: [context/request.ts](../../src/lib/context/request.ts) 三个 settle 点都要带上 status/statusText，覆盖用户「无论成功失败」:
  - `complete()`（成功，L500-527）: 读 `currentAttempt` 的 status/statusText 并入 `_response`（成功路径当前 `_response` 不含 status → 现在含）。
  - `fail()`（失败，L541-566）: 已有 `_response.status = error.status`——**对账避免双写**，statusText 从 `error.statusText`（`HTTPError` 补后）取，勿再从 attempt-merge 重复写。
  - `abort()`（L593-602，**review 新增 MAJOR-D3**）: 另起的 `_response` 须从 `currentAttempt` 取回已捕获 status/statusText，否则「client 断开但上游已 200」的 aborted 请求顶层 status 缺席、DiagnosticBar 不显示。
  - 每次尝试失败投影 `synthesizeAttemptErrorResponse`（L116-129，**review 新增 MINOR-C4**）: 现 `status: a.error.status`，补 `statusText: a.error.statusText`。
- **类型 + 投影（review 修正 MAJOR-C1，真正卡点）**: `ResponseData`（context/types.ts）`status` 改为成功也填 + 新增 `statusText?`；`OutboundResponseData`（history/types.ts:210-219）加 `statusText?`（与 `attempts[].response` 同型，一改两得）；**`responseDataToHistory`（[sinks/history.ts:312-329](../../src/lib/observability/sinks/history.ts) 是硬字段白名单、无 spread）必须显式加 `statusText`——否则在此处静默丢弃**（`updateEntry` 是整体 `Pick` 透传、安全，无需在那核验；review 纠正原「注」的误导）。该函数同覆盖顶层 `toHistoryResponse` 与 per-attempt `toHistoryAttempts`，一改两处生效。ui-v4 经 `~backend/*` re-export 自动获得（`status` 本已投影，成功路径 set 后自动流经）。

### B.3 显示层约束: HTTP/2 无 reason-phrase

HTTP/2 协议**没有 reason-phrase**，h2 上游（本项目主路径）的 `Response.statusText` 通常为 `""`；h1/undici 回退路径可能有值。取向:
- **捕获**: 原样存 `statusText`（可能 `""`），不臆造。
- **显示**: 详情页在 `statusText` 为空时，用状态码派生规范短语兜底（如 429 → "Too Many Requests"、200 → "OK"）。新增前端 `httpReason(code)` helper（RFC 7231/常见码映射）。合成短语**仅用于显示**，不写回捕获数据（合成物不污染真实轨——richest-data-flow 对称面）。

### B.4 前端顶层显示

- [DiagnosticBar](../../ui-v4/src/components/detail/DiagnosticBar.tsx): 加 `HTTP <status> <statusText || httpReason(status)>` 芯片，按 2xx(ok)/4xx(warn)/5xx(fail) 着色；status 已知即显示（成功也显示 `HTTP 200 OK`）。status 缺席（WS 路径 / 网络错误）→ 不显示该芯片（不臆造）。
- [ResponseSegment.tsx:202](../../ui-v4/src/components/detail/segments/ResponseSegment.tsx) 既有 status 行: 成功路径接线后自然显示真实码，并追加 `statusText || httpReason`。

### B.5 验收标准（B）

1. 成功请求详情页 DiagnosticBar 显示 `HTTP 200 OK`（h2 statusText 空 → 派生 "OK"）；ResponseSegment status 行不再是 `—`。
2. 失败请求（如上游 429）显示 `HTTP 429 <statusText || "Too Many Requests">`，着色 warn。
3. 导出的 `HistoryEntry.outboundResponse` 含 `status`（成功=200）与 `statusText`；每次尝试 `attempts[].response` 同样含。
4. **aborted（MAJOR-D3）**: client 中途断开但上游已回 200 的 aborted 请求，顶层 `outboundResponse.status` = 200（从 attempt 取回），DiagnosticBar 芯片显示。
5. **interrupted（MINOR-D2）**: interrupted 终态 entry 若 attempt 层有 status，导出/显示不丢（无 status 则芯片缺席，不报错）。
6. upstream-WS 成功请求: status 缺席不报错，芯片不显示。

## 5. 特性 C —— 详情页 per-attempt 展示骨架

### C.1 设计

详情页新增 **`Attempts` 分段**（[DetailSubRail](../../ui-v4/src/components/detail/DetailSubRail.tsx) 加一个 segment；[DetailPanel](../../ui-v4/src/components/detail/DetailPanel.tsx) 加对应 `Tabs.Content`）。当 `entry.attempts` 存在且 >1（或始终显示、单尝试时也列 1 条）时，遍历 `attempts[]`，每次尝试渲染:
- 头行: `attempt N` + strategy + `HTTP <status> <reason>`（复用 B.3 的 `httpReason`）+ duration + transport + error（若有）。
- 可展开体: `effectiveRequest`/`wireRequest`/`response`/`responseHeaders`/`sseEvents`——**复用既有 block/segment 渲染器**（如 Headers 表、SSE 帧列表、JSON 块），不重造。
- 缺席字段（legacy 单 blob entry / 部分持久化的 interrupted attempt 无 per-attempt 体）显式标注「本次尝试无 X」，不静默空白（never-swallow）。

顶层 Stages/Response/SSE/Headers 段维持现状（= 最终尝试），Attempts 段是「每次尝试」的补充视图，两者互不破坏。

### C.2 验收标准（C）

1. 含 ≥2 次尝试的 entry（如 attempt1 429 → attempt2 200）: Attempts 段列出每次尝试，各自 status 可见（attempt1 显示 429、attempt2 显示 200）。
2. 每次尝试可展开看到该次的 effectiveRequest/wireRequest/response/responseHeaders/sseEvents。
3. 单次尝试 / legacy 无 attempts 的 entry: Attempts 段不崩、优雅降级（列 0/1 条或提示无 per-attempt 数据）。

## 6. 测试计划

- **后端单测**:
  - `handleExportBundle`（多 id 全 richest、混状态、含 missingId、空/非法 body 400、history 未启用 400）。
  - status/statusText 捕获经 history sink 投影到 `outboundResponse` + `attempts[].response`: 成功 200、失败 4xx/5xx、**aborted（上游 200 但 client 断）顶层 status=200**、WS 无 status、网络错误无 status。断言 `responseDataToHistory` 输出含 statusText（防白名单漏字段静默丢——正样本 oracle）。
- **前端单测**（vitest + jsdom）: 复选切换不导航、全选=已加载行、导出调 `postBlob` 传正确 ids、`downloadEntriesAsZst` 触发下载；`httpReason` 映射；DiagnosticBar 渲染 status 芯片（含 h2 空 statusText 派生、缺席不渲染）；Attempts 段遍历渲染 + 单尝试降级。断言配正样本（否定断言不自证——skill `debugging-frontend-tests`）。
- **导出四项 oracle（MAJOR-D4）**: 种子含 ≥2 尝试 + per-attempt 体 + httpHeaders 的 entry，`decompress` 后逐 attempt 断言 5 字段俱在。
- **交付验证**: 前端改动跑 `bun run build:ui`（typecheck+vitest 会双假绿，只有 rollup 暴露 `~backend/*` 纯度问题——skill `debugging-frontend-tests`）。

## 7. 影响面清单

**后端**: `routes/history/{route,handler}.ts`、`pipeline/types.ts`（UpstreamStream +status/statusText）、`pipeline/driver.ts`（两处写 attempt meta）、`transport/send.ts`（surface status——HeadersCapture 或返回形状）、`transport/{http-transport,responses-transport}.ts`（透传）、`error/{http-error,classify}.ts`（+statusText）、`context/types.ts`（Attempt +status/statusText、ResponseData +statusText/status-on-success）、`context/request.ts`（complete/fail/abort 合并 + synthesizeAttemptErrorResponse）、`observability/sinks/history.ts`（responseDataToHistory +statusText——**真正卡点**）、`history/types.ts`（OutboundResponseData +statusText）。
**前端**: `lib/{api,export-entry,http-reason}.ts`（后二新增/新建）、`stores/selection-store.ts`(新)、`components/requests/{HistoryList,RequestRow}.tsx`、`components/detail/DiagnosticBar.tsx`、`components/detail/DetailPanel.tsx` + `DetailSubRail.tsx`（+Attempts 段）、`components/detail/segments/AttemptsSegment.tsx`(新) + `ResponseSegment.tsx`（status 行补 statusText）。

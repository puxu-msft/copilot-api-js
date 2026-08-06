# Responses ↔ Anthropic 语义桥规格评审记录

> **状态**：进行中，首轮整改已完成，待提交与原 reviewer 复审
>
> **评审对象**：`docs/spec/2026-08-06-responses-anthropic-semantic-bridge.md`
>
> **首轮基线**：`63c784cc`（规格核验基线 `192dce69f1bf482b1c3130d519991594a3fe46ab`）

## 评审视角

| 视角 | 主责 |
|---|---|
| 协议与验收判据证伪 | 核 F1–F8、N1–N5、P0、AC；构造 false-green／false-red；检查真实 Claude Code WebSearch 外层行为 |
| 实施者第一人称走查 | 沿当前 hub、CellAssembly、双向 whole／stream translator、错误路由和 History 契约走 Phase 1–5 |

## 首轮结论

- 协议 verifier：1 BLOCKER。
- 架构 reviewer：0 BLOCKER、6 MAJOR。
- 两个 reviewer 的隔离 worktree 均保持干净。

## 发现与处置

### B1. Web Search 专用 lifecycle event 未纳入 known handler

- **原级别**：BLOCKER。
- **处置**：采纳（C）。
- **事实复核**：当前 OpenAI SDK 的 `ResponseStreamEvent` 包含 `response.web_search_call.in_progress`、`searching`、`completed`；本地 `ResponsesStreamEvent` 未建模，当前 translator 会落入 default。
- **失败场景**：按原规格启用 unknown fail-loud 后，合法 Web Search 进度事件会被拒绝；若继续忽略，则违反禁止 silent drop。
- **整改**：新增 F9；定义完整 Web Search lifecycle disposition、`output_index` 状态转换、完整序列正控及缺 added／重复／乱序反向控制；P0-3 改为真实外层 `WebSearch.call()`／CLI tool-use oracle。

### M1. Request／response registry 契约混用

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：Responses→Anthropic request translator 还承担 payload tools＋choice 联动、flat-item turn fold 和 carrier reconstruction，职责不同于 response item mapper。
- **整改**：拆成四张方向表；request handler 使用 `RequestItemDecision`，每个 request profile 必须有 `RequestPayloadCoordinator`；response handler 使用双平面 `BridgeDecision`。

### M2. 原 lifecycle router 只描述 Responses

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：Anthropic stream 使用 `content_block_start/delta/stop` 与 block `index`，不能套入 Responses `output_index` envelope。
- **整改**：改为 protocol adapter → 小 lifecycle algebra → handler 私有 state；Responses key 保留 `output_index`，Anthropic key 保留 block `index`。D2 明确该方案是择优，不是唯一可行实现。

### M3. Emission／collector／affinity 接口不足

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：原 `BridgeEmission` 未定义 citation；普通 tool result 与 server-tool result 未分型；continuation collector 与模型兼容边界没有接口。
- **整改**：定义 `BridgeCitation`、client/server tool call/result 分型、`ContinuationCollector`、`ContinuationBundle`、`ResponseRenderInput` 与 `SourceAffinity`；whole／stream 不得在 closure 私藏第二份 continuation 状态。

### M4. Unknown compatibility error 未接当前 commit seam

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：当前 live handler 已进入 `streamSSE`；renderer throw 会被 driver 折成 `stream-error` outcome，不能回到未提交 HTTP 响应。
- **整改**：定义 typed `BridgeCompatibilityError`；分别冻结 request、whole、buffered-uncommitted、live-committed 四格路由；live 格只允许目标协议合法 terminal error；driver outcome 保留原 Error 对象与结构化字段。

### M5. Disposition 没有 candidate owner 与 append-only SSOT

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：当前 `PipelineInfo.translation.anthropicToResponses` 是 request-global 单值槽，不能表达多 item、多 candidate；项目存在 generation candidate 与 winner selection。
- **整改**：每 candidate 使用 append-only collector；所有候选记录进 attempt/candidate 明细；只有 winner 投影到顶层 `pipelineInfo.bridgeDispositions`；新增窄 `appendCandidateBridgeDisposition` API，禁止复用 `recordFeature` 或单值 degradation 槽。

### M6. N2／N3 把择优写成伪必要性

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：原规格表格已承认方向专属 normalized value、每 handler 独立状态机可行，却仍声称窄 IR／共同 router“必须”。
- **整改**：N2／N3 改为 D1／D2 架构选择；补方向专属 normalized value、双协议 router 等可行方案；按长期维护、类型判别力和扩展性推荐窄 IR 与 adapter＋algebra，并规定 PoC 证伪后的回退条件。

## 整改后的新增验收

- Web Search 完整 lifecycle sequence 与生命周期反向控制。
- 外层 Claude Code `WebSearch.call()` 最终 `data` 与主 loop `tool_result` oracle。
- 四张方向表与 request payload coordinator 守卫。
- request／whole／buffered-uncommitted／live-committed 四格 compatibility error。
- candidate-local append-only disposition 与 winner-only 顶层投影。
- `response.web_search_call.searching` 误入 unknown、loser 污染 winner 等目标 mutation。

## 待复审命题

1. B1 与 M1–M6 是否全部闭合。
2. 新增接口是否足以让 planner 不再临场发明承重 contract。
3. D1／D2 是否正确区分可行性与择优，没有残留伪必要性。
4. 本报告是否忠实转录两位 reviewer 的首轮发现、严重度与处置。
5. 若只剩 minor，reviewer 应明确写“可定稿”。

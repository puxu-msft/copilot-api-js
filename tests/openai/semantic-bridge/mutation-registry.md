# Semantic bridge mutation registry

本文件是 semantic bridge 阻断式判据与 mutation 明细的单一事实源（SSOT）。来源权威为 `plan-semantic-bridge` 分支 commit `6c95c279` 的 RFC §12、C0.2 九条 KNOWN-LOSS，以及 C0.1／C0.2 已执行 mutation 记录。后续汇总只能从本表派生，不得另维护计数。

> **mutation 不变红有三解**：①测试没咬住 ②mutation 没生效 ③fixture 造不出被测状态。排除前两条后，**先写探针问「这个状态真的存在吗」**，别改断言凑绿。
>
> **变异注入与撤销**：先构造只描述该变异的 exact patch → `git apply` 注入 → `git apply --reverse` 同一份冻结件撤销。`--reverse --check` 失败或与当前改动重叠就停下问用户。**绝不整文件 `git checkout`**。
>
> **registry 是明细 SSOT，任何汇总是派生视图**。别在别处另维护一份计数。

“失败来自目标机制？”只有已实际观察失败信息指向目标机制时写“是”；未来片尚未执行的写“未验”。行号只作提示，执行时必须按给出的函数与源码内容定位。

## 来源清单

### RFC §12 验收矩阵

`RFC-RESP-LIFECYCLE`、`RFC-ANTHROPIC-LIFECYCLE`、`RFC-MULTI-REASONING`、`RFC-ENCRYPTED-ONLY`、`RFC-FUNCTION-ARGS-DONE`、`RFC-ORDERED-TURN`、`RFC-SERVER-TOOL`、`RFC-SCENARIO-AB`、`RFC-FORWARD-SEAMS`、`RFC-DELIVERY-AUTHORITY`、`RFC-PRECOMMIT-RETAIN`、`RFC-OBSERVATION-STAGES`、`RFC-SOURCE-DIAGNOSTICS`、`RFC-CAPABILITY-POLICY`、`RFC-CARRIER-PROVENANCE`、`RFC-SAME-MODEL-REPLAY`、`RFC-CUTOVER-REACHABILITY`。

### C0.2 KNOWN-LOSS

`LOSS-SDK-LIFECYCLE`、`LOSS-ORDERED-TURN`、`LOSS-SERVER-TOOL`、`LOSS-SCENARIO-B-REQUEST`、`LOSS-MULTI-REASONING`、`LOSS-ENCRYPTED-ONLY`、`LOSS-FUNCTION-ARGS`、`LOSS-INCOMPLETE-TERMINAL`、`LOSS-CAPABILITY-PRUNING`。

### C0.1／C0.2 已执行 mutation

`ACT-C01-MISSING-EVENT`、`ACT-LOSS-ENCRYPTED-ONLY`、`ACT-LOSS-MULTI-REASONING`、`ACT-WIRE-REASONING-BEFORE-FIXTURE`、`ACT-WIRE-TEXT-EVENT`、`ACT-WIRE-REASONING-AFTER-FIXTURE`、`ACT-WIRE-THINKING-DELTA`、`ACT-WIRE-A2R-TOOL-DELTA`、`ACT-WIRE-R2A-TOOL-DELTA`、`ACT-WIRE-A2R-NONSTREAM-REASONING`、`ACT-WIRE-R2A-NONSTREAM-REASONING`、`ACT-WIRE-503-BODY`、`ACT-WIRE-HEADER`、`ACT-WIRE-STATUS`、`ACT-WIRE-ENCRYPTED-ONLY`、`ACT-WIRE-REDACTED`、`ACT-COVERAGE-SKIP-A2R-REASONING`、`ACT-COVERAGE-SKIP-R2A-REASONING`、`ACT-COVERAGE-SKIP-RETRY`、`ACT-COVERAGE-SKIP-NONRETRY`。

## Registry

| 判据 ID | 目标机制 | mutation（exact patch 描述） | 期望变红的用例 | 失败来自目标机制？ | 落实于 |
|---|---|---|---|---|---|
| `RFC-RESP-LIFECYCLE` | `responses-emitter` 生成完整 response／item／part lifecycle | 打开 `src/lib/pipeline/semantic/emit/responses-emitter.ts` 的 content-part close 分支，删除 `response.content_part.added` emission，但保留 `.done` | C8.1 `Responses lifecycle：真实 OpenAI SDK 接受完整 text part` | 未验 | C8.1 |
| `RFC-ANTHROPIC-LIFECYCLE` | `anthropic-emitter` 每帧 event 名与 block lifecycle／signature 完整 | 打开 `src/lib/pipeline/semantic/emit/anthropic-emitter.ts` 的 `signature_delta` emission，把 `event` 名从 `content_block_delta` 改为 `content_block_start` | C8.2 `Anthropic lifecycle：真实 SDK 累积 thinking + signature` | 未验 | C8.2 |
| `RFC-MULTI-REASONING` | ledger 与 Anthropic emitter 按 item key 隔离 reasoning | 在 `src/lib/pipeline/semantic/emit/anthropic-emitter.ts` 把 reasoning state Map 改为单个槽位，使后一 item 覆盖前一 item | C8.2 `多个 reasoning item 不串槽` property | 未验 | C8.2 |
| `RFC-ENCRYPTED-ONLY` | opaque-only reasoning 即使 visible 为空也可投影 | 在 `src/lib/pipeline/semantic/emit/anthropic-emitter.ts` 把 thinking emission 门改为仅 `visible.text.length > 0` | C8.2 `encrypted-only reasoning 保留` parity | 未验 | C8.2 |
| `RFC-FUNCTION-ARGS-DONE` | function call 使用 authoritative `.done.arguments` | 在 `src/lib/pipeline/semantic/emit/responses-emitter.ts` function-call close 分支改为只用 delta buffer、忽略 snapshot authoritative arguments | C8.1 `function args：无 delta／有 delta／冲突` property | 未验 | C8.1 |
| `RFC-ORDERED-TURN` | ordered transducer 默认保持 source ordinal | 在 `src/lib/pipeline/semantic/ordered-turn.ts` 删除具名规则检查，并按 kind 把 text 固定移到 tool 前 | C4 `双向 text/tool source ordinal 保持` property | 未验 | C4.1/C4.2 |
| `RFC-SERVER-TOOL` | 四格共用 disposition 且不伪造签名块 | 在 `src/lib/pipeline/semantic/server-tool.ts` 的不可表达 result 降级分支，返回 `web_search_tool_result` 而非含 correlation ID 的 text | C5.1 `server-tool 红线：永不合成 web_search_tool_result` | 未验 | C5.1/C5.2 |
| `RFC-SCENARIO-AB` | request consumer 与 response renderer 同时应用 carrier policy | 打开 C7.2 新建的 `src/lib/pipeline/semantic/carrier-v2.ts` request-consumer 投影函数，在它调用 `carrierAction` 后把 `{kind:"strip-opaque-preserve-visible"}` 的结果强制改回 `{kind:"preserve"}` | C7 `Scenario B request consumer 剥离 opaque` on/off 双控 | 未验 | C7.2 |
| `RFC-FORWARD-SEAMS` | A→R 的 translateOut／prepareWire／retry baseline 三点全部走新路径 | 打开 C9 将修改的 `src/lib/pipeline/hub-translate.ts`／Responses outbound leg／retry baseline 构造点，分别把 B-2、B-3、B-4 的新 semantic dispatch 恢复为当时仍可 import 的 legacy bridge；每点单独构造 exact patch | C9 `前向三点 seam 首次 dispatch + retry 正控` | 未验 | C9 |
| `RFC-DELIVERY-AUTHORITY` | 任一时刻恰一个 active authority，transfer 晚于 closing ACK | 在 `src/lib/pipeline/semantic/lineage.ts` transfer 函数中，把 publish 移到 closing sink ACK 之前 | C2.3 `transfer 中点：恰一个 active authority` | 未验 | C2.3 |
| `RFC-PRECOMMIT-RETAIN` | retain 的有 wire／空 segment／flush fail 三支正确 | 打开 C2.3 修改后的 `src/lib/pipeline/generation/coordinator.ts` 的 pre-commit retain 分支，把“旧 segment 无可发 wire effect”臂从 discard 改为也创建 `transferred` ancestor | C2.3 `pre-commit retain：空 segment 无 transfer` | 未验 | C2.3 |
| `RFC-OBSERVATION-STAGES` | observation 单一当前 stage，wire ACK 后才 emitted | 在 `src/lib/pipeline/semantic/observation.ts` 把 stage 晋级改为 append，保留旧 stage 副本 | C3.1 `每 observationId 只有一个当前 stage` | 未验 | C3.1 |
| `RFC-SOURCE-DIAGNOSTICS` | source-signed／unsigned／redacted 均可诊断且不伪造正文 | 在 C7 redacted policy 分支生成可读明文 `"[redacted]"` | C7.2 `跨协议 redacted 不伪造明文` 负控 | 未验 | C7.2 |
| `RFC-CAPABILITY-POLICY` | structured output／context management fail-closed 或 typed degradation | 在 `src/lib/pipeline/semantic/context-management.ts` 把 `clear_tool_uses` 当作 compaction threshold 映射 | C6.2 `clear_tool_uses 无等价物，只能 reject／warn-drop` | 未验 | C6.2 |
| `RFC-CARRIER-PROVENANCE` | carrier canonical 编码与 protocol/provider/model 三维 provenance | 在 `src/lib/pipeline/semantic/carrier-v2.ts` decoder 删除 prefix↔kind↔source.protocol 联合校验 | C7.1 `交叉 prefix/kind/source 必须 fail-closed` | 未验 | C7.1 |
| `RFC-SAME-MODEL-REPLAY` | 同模型 Claude 原生 content 走旁路逐字回送 | 在 C8.0b 同模型分支删掉 bypass，强制进入 ingest→envelope→emitter 重建 | `G4 guard：same-model Claude thinking／redacted_thinking／text／tool_use replay preserves source order...` | 未验 | C8.0b/C10 |
| `RFC-CUTOVER-REACHABILITY` | cutover 无双发且 legacy dispatch 不可达 | C9 在 `src/lib/pipeline/hub-translate.ts` 的 A→R bridge table、C10 在反向 request／stream factory table 中各恢复一个 legacy dispatch 项，并让对应测试 route 命中；每方向独立 exact patch | C9/C10 `旧路径不可达` reachability mutation | 未验 | C9/C10 |
| `LOSS-SDK-LIFECYCLE` | legacy A→R text stream 缺 output-item added，SDK 拒绝 | 在 `src/lib/openai/translate/anthropic-to-responses-stream.ts` text block start 分支补 `response.output_item.added` | `KNOWN-LOSS：Anthropic→Responses stream omits response.output_item.added for text...` | 未验 | C9 |
| `LOSS-ORDERED-TURN` | legacy 两向 request translator 重排 text/tool | A→R：把 `translateAssistantBlocks` 的 text item 从 `unshift` 改为按 block ordinal push；R→A：让 `foldInputItems` 不再固定 thinking/text/tool 三槽顺序 | `KNOWN-LOSS：both request translators reorder text/tool source ordinals...` | 未验 | C9/C10 |
| `LOSS-SERVER-TOOL` | legacy server-tool history/live 四格丢结构 | 在 `src/lib/openai/translate/anthropic-to-responses-request.ts` 的 `server_tool_use` case 临时 push `{type:"function_call",call_id:block.id,name:block.name,arguments:JSON.stringify(block.input)}`，使四格 KNOWN-LOSS 的 request-use 空集合断言失败 | `KNOWN-LOSS：all four server-tool quadrants lose native structure today...` | 未验 | C9/C10 |
| `LOSS-SCENARIO-B-REQUEST` | legacy Scenario B 只接 response renderer | 在 `translateAnthropicToResponses` request consumer 解析 synthetic signature 后按 Scenario B 删除 `encrypted_content` | `KNOWN-LOSS：Scenario B strips the response carrier but the request consumer still reconstructs it...` | 未验 | C9 |
| `LOSS-MULTI-REASONING` | legacy non-stream 单槽覆盖多个 encrypted payload | 把 `responses-to-anthropic.ts` 中 `reasoningEncrypted = item.encrypted_content` 改为累加 | `KNOWN-LOSS：multiple reasoning items collapse into one thinking block...` | 是：期望 `enc-second`，收到累加值 | C0.2/C10 |
| `LOSS-ENCRYPTED-ONLY` | legacy non-stream 以 visible text 门控 thinking | 把 `responses-to-anthropic.ts` 中 `if (reasoningText.length > 0)` 改为 `>= 0` | `KNOWN-LOSS：non-stream encrypted-only reasoning is dropped...` | 是：新增空 thinking + opaque signature | C0.2/C10 |
| `LOSS-FUNCTION-ARGS` | legacy stream 不读取 start input，只有 delta buffer | 在 `anthropic-to-responses-stream.ts` tool start 时把完整 input 写入 args buffer | `KNOWN-LOSS：a streamed function call with authoritative start arguments but no deltas...` | 未验 | C9 |
| `LOSS-INCOMPLETE-TERMINAL` | legacy flush 用 completed event 包 incomplete payload | 在 `anthropic-to-responses-stream.ts` flush 按 status 选择 `response.incomplete` | `KNOWN-LOSS：an incomplete payload is emitted under response.completed...` | 未验 | C9 |
| `LOSS-CAPABILITY-PRUNING` | legacy 两向静默裁剪顶层 capability | 在任一 legacy request translator 把被裁字段保留到输出，或改为显式抛 typed error | `KNOWN-LOSS：top-level capabilities are silently pruned in both directions...` | 未验 | C9/C10 |
| `ACT-C01-MISSING-EVENT` | Anthropic oracle 检查 event 行存在且匹配 type | 构造测试 frame 时删除 `event` 字段，保持 data.type 不变，喂给 `assertAnthropicEventLineInvariant` | C0.1 oracle 自验“缺 event 行必须抛错” | 是：报 `frame type=... must carry an event: line` | C0.1 |
| `ACT-LOSS-ENCRYPTED-ONLY` | 已执行 encrypted-only 门 mutation | exact patch：`responses-to-anthropic.ts` 的 `reasoningText.length > 0` → `>= 0` | encrypted-only KNOWN-LOSS | 是 | C0.2 |
| `ACT-LOSS-MULTI-REASONING` | 已执行单槽覆盖 mutation | exact patch：`reasoningEncrypted = item.encrypted_content` → `reasoningEncrypted += item.encrypted_content` | multi-reasoning KNOWN-LOSS | 是 | C0.2 |
| `ACT-WIRE-REASONING-BEFORE-FIXTURE` | 首次探测 reasoning wire 覆盖面 | exact patch：`anthropic-to-responses-stream.ts` 的 `response.reasoning_summary_text.delta` → `.deltb`，运行当时 8 条基础 golden | 当时 wire golden 集 | 否：fixture 无 reasoning，mutation 生效但全绿 | C0.2 |
| `ACT-WIRE-TEXT-EVENT` | 基础 R→A text wire 字节判别力 | exact patch：`response.output_text.delta` → `response.output_text.deltb` | `R→A client wire：stream，no retry` | 是：固定 SHA-256 不匹配 | C0.2 |
| `ACT-WIRE-REASONING-AFTER-FIXTURE` | R→A reasoning delta wire 判别力 | exact patch：`response.reasoning_summary_text.delta` → `.deltb`，在 reasoning fixture 加入后运行 | `R→A client wire：stream reasoning summary + encrypted content，no retry` | 是：SDK summary 变空／digest 不匹配 | C0.2 |
| `ACT-WIRE-THINKING-DELTA` | A→R thinking wire 判别力 | exact patch：`responses-to-anthropic-stream.ts` 的 `thinking: event.delta` → ``thinking: `${event.delta}!` `` | `A→R client wire：stream thinking summary + signature...` | 是：SDK thinking 多 `!` | C0.2 |
| `ACT-WIRE-A2R-TOOL-DELTA` | A→R `input_json_delta` wire | exact patch：`partial_json: event.delta` → ``partial_json: `${event.delta} ` `` | `A→R client wire：stream tool_use + input_json_delta...` | 是：body length／digest 改变 | C0.2 |
| `ACT-WIRE-R2A-TOOL-DELTA` | R→A `function_call_arguments.delta` wire | exact patch：`delta: delta.partial_json` → ``delta: `${delta.partial_json} ` `` | `R→A client wire：stream function_call + arguments delta...` | 是：SDK 累积 args 多空格 | C0.2 |
| `ACT-WIRE-A2R-NONSTREAM-REASONING` | A→R non-stream thinking 字节 | exact patch：`responses-to-anthropic.ts` 的 `thinking: reasoningText` → ``thinking: `${reasoningText}!` `` | `A→R client wire：non-stream thinking + signature...` | 是：SDK thinking 多 `!` | C0.2 |
| `ACT-WIRE-R2A-NONSTREAM-REASONING` | R→A non-stream reasoning 字节 | exact patch：`anthropic-to-responses.ts` 的 `output.unshift(...reasoningItems)` 改为给每项 summary 追加 `!` | `R→A client wire：non-stream reasoning + encrypted content...` | 是：body length／digest 改变 | C0.2 |
| `ACT-WIRE-503-BODY` | 两方向错误 body 字节 | exact patch：`src/lib/error/forward.ts` 503 rate-limit body message 末尾追加 `!` | 两条 `HTTP 503 error body + retry headers` | 是：两方向 body length 各增加一字节 | C0.2 |
| `ACT-WIRE-HEADER` | 三维 digest 覆盖响应头 | exact patch：在 `assertFixedClientWireDigest` 对 `A→R:error:no-retry` 过滤掉 `x-should-retry`，body/status 不变 | A→R HTTP 503 golden | 是：canonical digest 改变 | C0.2 |
| `ACT-WIRE-STATUS` | 三维 digest 覆盖 HTTP status | exact patch：在 digest 前把 `R→A:error:no-retry` capture.status 改为 `502`，body/headers 不变 | R→A HTTP 503 golden | 是：canonical digest 改变 | C0.2 |
| `ACT-WIRE-ENCRYPTED-ONLY` | encrypted-only 缺陷现状的客户端字节 | exact patch：再次把 `reasoningText.length > 0` 改为 `>= 0`，运行 encrypted-only golden | `A→R client wire：non-stream encrypted-only reasoning（锁定当前丢失缺陷）` | 是：旧空 text 前新增 thinking | C0.2 |
| `ACT-WIRE-REDACTED` | redacted_thinking 缺陷现状的客户端字节 | exact patch：`anthropic-to-responses.ts` 的 `redacted_thinking` case 临时 push `[redacted-mutant]` text output | `R→A client wire：non-stream redacted_thinking（锁定当前丢失缺陷）` | 是：body 从丢失状态新增 text item | C0.2 |
| `ACT-COVERAGE-SKIP-A2R-REASONING` | 方向覆盖守卫对 A→R golden 删除敏感 | frozen patch 把 A→R thinking golden 的 `test(` 改为 `test.skip(` | 方向 coverage guard | 是：A→R marker 无登记 | C0.2 |
| `ACT-COVERAGE-SKIP-R2A-REASONING` | 方向覆盖守卫对 R→A golden 删除敏感 | frozen patch 把 R→A reasoning golden 的 `test(` 改为 `test.skip(` | 方向 coverage guard | 是：R→A marker 无登记 | C0.2 |
| `ACT-COVERAGE-SKIP-RETRY` | 18 元集合守卫区分共享 digest 的 retry 用例 | frozen patch 把 `A→R client wire：stream，retry` 改为 `test.skip` | `coverage guard：已执行 golden 用例键与冻结的 18 元集合精确相等...` | 是：精确点名缺 `A→R:stream:retry` | C0.2 |
| `ACT-COVERAGE-SKIP-NONRETRY` | 集合守卫对普通非 retry golden 删除敏感 | frozen patch 把 R→A stream reasoning no-retry 改为 `test.skip` | 同上 coverage guard | 是：精确点名缺 `R→A:stream-reasoning:no-retry` | C0.2 |

## 集合相等验收

验收脚本必须把“来源清单”三个小节的 backtick ID 与 Registry 第一列 ID 分别解析成集合，计算 `source - registry` 与 `registry - source`；两侧都为空才通过。不得用行数或 `rg -c` 代替。RFC 集合应从 RFC §12 表格逐行人工映射后，与上面的 17 元 ID 清单比对；KNOWN-LOSS 集合应从 JUnit 运行时枚举的九个 `KNOWN-LOSS：...` 用例映射；实际 mutation 集合应从 C0.2 进度、冻结 patch 操作记录与本表 ACT 行逐条对账。

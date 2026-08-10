# Task 1b 独立 Acceptance Verification

## 判定

**Acceptance FAIL**。目标构建 `3cd33f483ee14e4d901072efd11c84f04da7ae8c` 有 1 个 Critical、1 个 Important；未发现独立 Minor。Task 1b 的 parser／direct wire ID 主路径成立，但它把 upstream arena frame 改成 rich `ParsedSseFrame` 后，没有同步 History V3 projection consumer，导致现有用户可见 History 的 upstream `raw` 全部变空；新 encoder 对 multiline `event`／`id` 的 projection 也与实际 client-decoded bytes 不一致。

## 从冻结 Spec 独立推导的验收矩阵

| 验收面 | 独立 oracle | 结果 |
|---|---|---|
| absent ID | semantic current ID 为 `""`、`idField=absent`、client wire 无 `id:`、client History 等于独立解码 wire | PASS |
| explicit reset | semantic current ID 为 `""`、`idField=present("")`、actual bytes 含 bare `id:`、client History 等于独立解码 wire | PASS |
| inherit | current ID 为 `alpha`；两帧仅首帧 wire 带 `id: alpha`，第二帧 semantic 继承但 wire 不重复 | PASS；新增两帧 route oracle通过并经目标 mutation 变红 |
| parser edge cases | NUL ID 忽略、`007` 保持 string、`retry: 0` 接受、invalid retry 忽略、EOF pending 丢弃、CRLF／UTF-8 split | PASS |
| provenance lifecycle | parser→hook/rewrite 保留 provenance；direct 显式 projection；fresh translation／plain synthetic 不伪造 provenance | PASS（定向）；same-object translation 仍靠 object identity 判 direct，未找到当前 production translator 的错误样本 |
| encoder framing | event/data/id/retry、empty、Unicode、CRLF、multiline；actual bytes 由独立 decoder 与 projection 比较 | **FAIL：multiline event/id** |
| History 双轨 | upstream History 保留 rich parsed provenance；client track 只保存 wire projection | **FAIL：arena rich value 存在，但 History V3 upstream `sseEvents[].raw` 为空** |
| 真实 route | HTTP route→driver→renderer→raw Hono stream→History，不只 mock sink | PASS（ID 三态）；同时真实 route 暴露 History regression |
| Hono raw stream／heartbeat／anchor | raw `stream.write(bytes)` route、sink、heartbeat、anchor 定向回归 | PASS；未观察到 Task 1b 新增的 close/error 行为偏差 |
| Task 5／Task 3 边界 | `pendingLegacy` 不迁；classifier 仍只接 post-render wire | PASS：Task 1b diff 未改 architecture guard 或 `boundary-classifier.ts`；`response-processor` 在 yield 前 project |
| backend 归因 | 在一次性 snapshot 把 `30134734 352767f2 b58dc819 d6961943` 依序合入 `3cd33f48`，与同 backend commits 合入 `f2ec190b` 做 A/B | **FAIL，且 6 个 History failures 可归因 Task 1b** |

## Critical

### C1：upstream History 投影丢失所有 parsed SSE payload

**违反条款／要求：** 用户指定“upstream History 保 rich parsed”；冻结 Spec §3／§9.1 要求 semantic ID 与 wire presence 并存且 History 不丢 rich fact；项目 richest-data-flow 要求后端完整保存。

**最小复现状态→错误输出：** 任一真实 parsed upstream frame，例如 Responses `response.output_text.delta` 的 `message.data` 含 `PARTIAL_ATTEMPT_1`。`canonicalFrameValue()` 把 arena value 保存为 `{kind:"parsed-sse",message:{data:...},idField:...}`，但 `projection.ts` 的 `frameRaw()` 只读取顶层 `raw`／`data`，所以用户 History 得到 `sseEvents:[{type:"response.output_text.delta",raw:""}]`。具体生产接缝：

- `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/context/request.ts:552-565` 产出 rich nested arena value；
- `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/history/v3/projection.ts:51-75` 只认顶层 `raw`／`data`／`event`；
- `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/pipeline/stream/response-processor.ts:164-168` 把 rich wrapper交给 recorder。

**独立 A/B 证据：**

```text
Candidate snapshot bdd58a4242ed0ce29bbe7831b288cd2fec006591
bun test --isolate tests/responses/responses-buffered.it.test.ts tests/anthropic/tool-input-repair-fail.http.test.ts tests/responses/responses-buffered-merge-history.it.test.ts tests/anthropic/stream-truncation.http.test.ts
25 pass, 6 fail；例如 expected PARTIAL_ATTEMPT_1，received raw:""；expected content_block_start，received [undefined,undefined,undefined]。

Baseline snapshot 4c6106c3f139e53872173a488029fed3b671c65f
同一命令
31 pass, 0 fail。
```

这不是实施报告所称“仅 canonical performance ratio 环境 false-red”。它是 Task 1b 引入后稳定出现、前一实现不存在的 History 内容丢失。建议交回 **implementer**：根因已证实，需让 History projection／raw capture理解 `ParsedSseFrame`，同时保持 arena rich value与 client wire-only track分离。

## Important

### I1：multiline `event`／`id` 的 History projection 不等于客户端实际解码值

**违反条款／要求：** 用户明确要求 encoder 的 event/data/id/retry framing 覆盖 multiline／Unicode／CRLF，并由独立 decoder 校验 bytes 与 projection；Task 1b 自身契约称 `{bytes, projection}` 是同一 client-visible truth。

**最小复现：**

```ts
encodeSseFrame({ event: "first\rsecond", data: "a\r\nb", id: "alpha\nbeta", retry: 0 })
```

`/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/pipeline/sse-encoder.ts:27-37` 将 event/id 每行分别编码；按 WHATWG，重复 `event:`／`id:` 字段均由后值覆盖，因此客户端解码为 `{event:"second",id:"beta",data:"a\nb",retry:0}`，但 projection 是 `{event:"first\nsecond",id:"alpha\nbeta",...}`。现有 `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/tests/pipeline/sse-encoder.unit.test.ts:31-34` 用 encoder 自己的预期同时断 bytes 与 projection，形成同源假绿。

**独立 decoder 证据：** 新增于一次性 snapshot 的 test 首次对当前实现红；临时把 projection 改成独立 decoder语义后同一 test绿，证明不是测试装配错误。建议交回 **implementer**：根因明确，应决定并实现合法单行 event/id 语义；不得继续把重复字段当 data-style拼接。

## 实际运行与结果

- `bun test tests/transport/owned-sse-parser.unit.test.ts tests/transport/parsed-sse-frame.unit.test.ts tests/pipeline/sse-encoder.unit.test.ts tests/pipeline/response-processor.unit.test.ts tests/pipeline/client-sink.unit.test.ts tests/pipeline/generation-runtime-baseline.http.test.ts`：`61 pass / 0 fail`，目标快照 `/tmp/task1b-snapshot-aa6dd772`。
- 独立 two-frame route absent/reset/inherit oracle：`1 pass / 0 fail`；把 projection 变异为无条件输出 current ID 后按预期红，再恢复绿。
- 独立 WHATWG encoder decoder：当前实现 `0 pass / 1 fail`；修正 projection 的临时正样本 `1 pass / 0 fail`。
- deterministic backend integration snapshot：四个 commits 依序 merge-tree，无冲突；canonical isolated `5 pass / 0 fail`，typecheck exit 0。
- `bun run test:backend` 对该 snapshot 单次运行：`6163 tests，6147 pass，16 fail，1 shard crashed`（该总数未用第二原理交叉验证）；其中上述 4 文件 A/B 对照将 6 个确定性 History failures归因 Task 1b。

## 现有 tests 的假绿／false-red 结论

- **假绿：** encoder multiline test 同源断言，没有按 WHATWG 解码 actual bytes；因此 bytes 与 projection 同时“符合作者预期”却不等价。
- **假绿：** route reset fixture把 `id:` 放在 `[DONE]` 上，而 `[DONE]` 不进入 upstream History；它没有验证“current empty + present empty + actual bare id + History一致”的同一 dispatched event。独立 fixture改为首个 dispatched frame带 bare reset后仍通过。
- **false-red／陈旧契约：** `tests/transport/responses-transport.it.test.ts` 仍直接读 iterator value `.event`，Task 1b现在返回 `ParsedSseFrame.message.event`；这两条红属于测试未迁移，不是用户 route行为失败，但也推翻“backend只剩performance false-red”的报告。
- **真实红：** 6 条 History测试在 baseline全绿、candidate全红，且 wrong output都是 `raw:""`／missing content，不能归为 false-red。

## 验证资产

只读约束下未修改／提交项目 tests。临时、未提交资产位于 `/tmp/task1b-snapshot-aa6dd772/tests/pipeline/generation-runtime-baseline.http.test.ts`、`/tmp/task1b-snapshot-aa6dd772/tests/pipeline/response-processor.unit.test.ts`、`/tmp/task1b-snapshot-aa6dd772/tests/pipeline/sse-encoder.unit.test.ts`；持久化报告为本文件。

## 结构怪味与方法反思

- `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/context/request.ts:552-565` + `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/history/v3/projection.ts:51-75`：consumer shape drift／rich producer与旧 flat projector双源；处置：本轮报告 blocker，不改生产代码。
- `/home/xp/src/copilot-api-js/.worktree/agent-aa6dd772ce7c80052/src/lib/pipeline/stream/response-processor.ts:252-254`：以 object identity判断 direct vs translation，抽象泄漏；当前未找到 production wrong-output样本，故不升级为独立 finding，建议 Task 3 integration时改为显式 projection policy并补 same-object translation control。
- 更好的内部方案是让 frame projection consumer共享 `semanticSseMessage`／明确 parsed-frame projector，而不是每个 History consumer猜 shape；现有判据必须同时用真实 route与独立 decoder，单元 roundtrip不够；第三方 Hono serializer无法表达 empty `id:`，保留自有狭窄 encoder合理，但 event/id grammar仍须按 WHATWG而非手写同源预期裁决。

# Task 1b Acceptance Rereview

## 判定

**Acceptance FAIL**。目标 `980eaf09600034772f6f0be0f98ec94465d5053c`：**Critical 0、Important 1、Minor 0**。原 C1 与 multiline encoder 缺陷已关闭；但公开 `createResponses()` streaming contract 仍直接返回新的 rich `ParsedSseFrame`，使既有调用者读取 `.event/.data` 全部得到 `undefined`，且 full backend 稳定红。

## 验收矩阵与实测

1. 原 C1 四文件：`31 pass / 0 fail`。History upstream raw恢复；`src/lib/history/v3/projection.ts:51-87` 读取 nested message，而 arena仍保存 rich wrapper；client route History仍与 decoded wire一致。移除 nested projection的正控使 `PARTIAL_ATTEMPT_1` 目标测试红。
2. 独立 WHATWG decoder：multiline event/id、CRLF data、retry 0 的 actual bytes等于projection；invalid retry `-1/1.5/Infinity/>MAX_SAFE_INTEGER`均 fail closed。独立 oracle `2 pass / 0 fail`；移除 retry guard后目标测试红，恢复后绿。
3. 真实 `/chat/completions` route absent/reset/inherit：`1 pass / 0 fail`；reset普通 completion event实际 bytes含 bare `id:`，arena保 `{message,idField}`，client History wire-only。
4. provenance：refusal-recovery end_turn/error origin、identity projection、fresh equal-fields translation无伪 provenance，相关 4 文件 `85 pass / 0 fail`。
5. deterministic performance commits均为HEAD祖先；canonical `5 pass / 0 fail`，typecheck绿。full backend：`5062 tests，5055 pass，7 fail`（单次口径）；其中4条集中于 public Responses client contract。
6. Task 3 seam：`3cd33f48..HEAD` 未改 `boundary-classifier.ts`、delivery grammar或mandatory graph；未越界接 classifier。

## Important

### I1：public Responses streaming client shape被Task 1b破坏

状态→错误输出：`createResponses({stream:true})` 的用户取得 async iterator，既有公开测试与调用约定读取首帧 `.event === "response.created"`；当前 iterator value是 `{kind:"parsed-sse",message:{event:"response.created",...},idField:...}`，所以 `.event === undefined`。`tests/responses/openai-responses-client.it.test.ts` isolated 为 `5 pass / 4 fail`；同 deterministic baseline snapshot为 `9 pass / 0 fail`，可归因Task 1b。四个失败覆盖普通 HTTP stream、WS→HTTP fallback、abort fallback和shutdown TOCTOU fallback。

生产位置：`src/lib/transport/send.ts` 的 `ownedResponseEvents()` 现直接返回 `ParsedSseFrame`；`src/lib/openai/responses-client.ts`（public `createResponses`）未在边界投影回既有 `ServerSentEventMessage`。Task内 `tests/transport/responses-transport.it.test.ts`改为读取 `.message.event`只迁了内部测试，没有保护public contract。

建议交回 **implementer**：根因明确。rich provenance应停留在 pipeline-owned transport入口；public legacy client边界必须显式project semantic message，或用分离的internal API承载rich frame，不能要求所有外部消费者改读`.message`。

## 资产与命令

临时独立 oracle：`/tmp/task1b-rereview-aa6dd772/tests/pipeline/sse-encoder.acceptance.unit.test.ts`；route bare-id增强在同snapshot的`generation-runtime-baseline.http.test.ts`。未提交。报告为本文件。

结构怪味：`src/lib/transport/send.ts`＋public Responses client是“内部rich carrier泄漏公开契约”；处置为Important。更佳方案是分离internal rich iterator与legacy plain iterator；判据已由baseline A/B和真实public consumer交叉验证；无第三方库可替代该契约边界修复。

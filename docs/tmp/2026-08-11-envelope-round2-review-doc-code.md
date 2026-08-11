# RequestEnvelope 三作用域文档↔代码评审（round 2）

评审范围：commit `06bc3535`、`30a6d406`、`49c862ad`、`c2679ff2` 在 `4bdbe93a478c` 的最终代码与相关文档、注释、hook 示例；仅核对 doc↔code。

已读取／执行的证据：CodeGraph 查询 `RequestEnvelope`／`writeAttempt`／`CandidateStateFactory`／四 codec；源码与测试定点读取；全仓 `rg` 按称呼表扫描 `env.requestState`、`RequestEnvelope.requestState`、`env.with(`、`.with(`、`request-state.ts`、`copy-on-write`、`defensive snapshot` 与不可变措辞。

总体 verdict：修复 3 个 major 后可定稿。blocker：0。

## 可核验断言

- C1：成立。`writeAttempt` 以 `Object.assign(env.attempt, next)` 就地写入并 `return env`，故返回同一对象。证据：`/home/xp/src/copilot-api-js/src/lib/pipeline/envelope.ts:237-245`。
- C2：成立。`view` 是 `makeEnvelope` 对象字面量的 getter，逐次以当前 `env.attempt.body` 调 `createView`；裸 `{...env}` 会取值并固化该次结果。证据：`/home/xp/src/copilot-api-js/src/lib/pipeline/envelope.ts:214-225`；两处新注释的理由与此相符：`/home/xp/src/copilot-api-js/src/lib/codec/anthropic/poisoned-thinking-retry.ts:92-95`、`/home/xp/src/copilot-api-js/src/lib/anthropic/thinking-quarantine/proactive-filter.ts:116-118`。
- C3：成立，但实际覆盖两种输入来源：四 codec 在无 `originalBodyForHistory` 时均 `structuredClone(raw.body)`；已有 route snapshot 时读取 `snapshotHistoryBody`，而该 snapshot 创建时也 `structuredClone`。证据：`/home/xp/src/copilot-api-js/src/lib/codec/{anthropic,openai-cc,openai-responses,gemini}/codec.ts:412-415,356-359,419-422,331-336`；`/home/xp/src/copilot-api-js/src/lib/pipeline/types.ts:270-280`。
- C4：成立。测试分别让 hook 原地 splice 后返回 `undefined`，以及 `writeAttempt` 后返回 env；两个 transport 均捕获 `e.attempt.body` 并断言改写到达。证据：`/home/xp/src/copilot-api-js/tests/pipeline/hooks/client-inbound.unit.test.ts:65-99`；契约文本：`/home/xp/src/copilot-api-js/src/lib/pipeline/hooks/types.ts:35-42`。
- C5：所点名的 cell-fork 判别器、三作用域和 candidate fork 描述成立。`migratedCell` 读取 `env.request.legSupplyReady`，`forkEnvelope` 引用共享 request，`CandidateStateFactory` 为 body／hints clone 且为 opaque candidate holders 重建；DESIGN 的 cell-assembly 行与目录行相符。证据：`/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:383-393`、`/home/xp/src/copilot-api-js/src/lib/pipeline/envelope.ts:229-245`、`/home/xp/src/copilot-api-js/src/lib/pipeline/generation/candidate-state.ts:50-78`、`/home/xp/src/copilot-api-js/docs/DESIGN.md:92,152`。
- C6：不成立。精确 API 与同义称呼仍留在可被当作当前契约阅读的文档／示例中；具体影响见下面第 1、3 条 major。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/DESIGN.md:93` — 活架构表仍称 `client.inbound` 获得防御性 body clone、`undefined` 保留原 parsed env；这与 live-env／就地修改到 wire 的现行契约相反。证据：`/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:441-445`、`/home/xp/src/copilot-api-js/src/lib/pipeline/hooks/types.ts:35-40`。修复：改为 live env、`undefined` 表示原地写已完成、`writeAttempt` 返回同一 env，并移除旧行号断言。

[major] `/home/xp/src/copilot-api-js/docs/spec/2026-07-12-upstream-hook-middleware.md:3,116-124,273,339` — 「取代注记」未完整取代 v3 机制：它说第 1 条保留，但旧第 1 条仍明确主张 driver 防御性 snapshot；页首、验收项和触点清单也继续把 snapshot 当现状／要求。失败场景：hook 作者按 §3.5 或验收项实现，会期待原地写被隔离，实际却写进 wire。修复：只保留「codec 原样轨独立」这一仍成立的子命题，明确整段旧 snapshot／immutable-return 机制已 superseded，并同步页首、§3.5 验收与触点清单。

[major] `/home/xp/src/copilot-api-js/docs/v4/03-spec/envelope-driver.md:15-40`、`/home/xp/src/copilot-api-js/hooks/strip-todowrite.ts:5-9,25-30`、`/home/xp/src/copilot-api-js/docs/spec/2026-07-26-server-tool-provenance-routing.md:289,828`、`/home/xp/src/copilot-api-js/docs/rfc/2026-07-21-retry-strategy-registry.md:18` — C6 的「只剩明确历史引用」不实：DESIGN 仍链接前一份 v4 规格，而它定义已删 `with()` 和不可变信封；可加载的 hook 示例仍承诺 helpers 返回新 env；待用户裁决的 spec 与 landed RFC 仍把已删 `requestState` 描述为当前载体。修复：将 v4 规格与 hook 示例同步为三作用域／`writeAttempt` 契约；为历史 RFC 加 2026-08-11 supersession 注记；将待实施 spec 的载体分析迁到 `request`／`candidate`／`attempt`。

## 主观建议

未提出。本轮只报告 blocker 与 major。

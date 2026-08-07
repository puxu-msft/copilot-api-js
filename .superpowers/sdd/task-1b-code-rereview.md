# Task 1b Code Rereview

评审范围：接力修复 `02611afb` 与收口 `980eaf09`，复核原 1 blocker、2 major、1 minor及新增 History Critical，并扫描同类回归。

已读取／执行证据：读完修复 diff、相关产品代码与测试；目标 7 文件套件 121 pass／0 fail；S8 synthetic provenance 2 pass；Responses transport 7 pass；typecheck 通过；生产 parser 探针证合法 multiline/event/id/retry 与 projection 一致；另写两个只读反例探针。

总体 verdict：Spec FAIL；Quality CHANGES_REQUIRED；blocker 0；major 2；minor 1。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktree/agent-a5c59dd66952edb78/src/lib/transport/parsed-sse-frame.ts:39-50` — fresh synthetic rewrite output仍继承 parsed `idField`，违反“fresh output不伪继承 provenance” — `mapSemanticSseFrame`对任何非 identity output都重建 wrapper并保留输入 `idField`；独立生产接线探针令 parsed input经 fresh `refusal-recovery` frame后输出 `{event:"error",data:"synthetic",id:"alpha"}`，synthetic frame伪带源事件 ID。现有新增测试只覆盖 renderer fresh output，不覆盖 rewrite fresh output。修复应让 rewrite contract显式区分 identity-preserving rewrite与fresh constructed output：仅前者保 wrapper/idField；后者保持 plain `SseFrame`，同时保留其自身 synthetic origin。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-a5c59dd66952edb78/src/lib/pipeline/sse-encoder.ts:17-44` — encoder仍会让 `bytes` 与 `projection` 对合法类型输入分叉 — `id`类型允许任意 string，但 `normalizeSingleLineField`不处理 U+0000；探针输入 `{data:"payload",id:"bad\0id"}` 得 projection `{id:"bad\0id"}`，独立 WHATWG decoder按规范忽略该 field并只见 `{data:"payload"}`。修复应对含 NUL 的 ID fail closed或省略该字段及 projection，并补 bytes↔独立 decoder正反控；同时扩非法 retry表到负数、小数、Infinity、超 safe integer。

[minor] `/home/xp/src/copilot-api-js/.worktree/agent-a5c59dd66952edb78/tests/pipeline/sse-encoder.unit.test.ts:41-43` — 测试名“does not let a synthetic origin…”与断言仅验证 newline event不抛错，既未构造 synthetic origin，也未断 provenance — 会误导未来维护者，以为覆盖了该边界。改为真实 provenance断言或删除并由准确命名的 normalization case替代。

已确认修复：History rich `ParsedSseFrame` arena 保真且 raw/type projection正确；direct identity projection转移 synthetic origin；普通 data event上的 bare reset到真实 wire/client History已覆盖；decoder已集中并按 WHATWG final event/id语义实现；陈旧 Responses transport断言已迁 nested message；原 S8 两条回归转绿。

双向判据：正确样本均绿；fresh rewrite与 NUL ID 两个错误样本当前也绿／可产出错误结果，构成 false-green，故不能放行。未发现 false-red：合法 multiline、retry 0、bare reset及 direct identity均通过生产 parser或route正样本。

结构怪味：`parsed-sse-frame.ts:39-50` 的“rewrite结果一律wrapper化”是阶段边界抽象泄漏，处置：本轮修；`sse-encoder.unit.test.ts:41-43` 是命名与实际 oracle 不符，处置：本轮修。第三方方案：无需引入库；现有窄 encoder＋独立 WHATWG oracle合适，问题在边界规则未闭合。

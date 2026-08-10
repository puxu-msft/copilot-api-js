# Task 1b Parsed SSE 独立代码评审（转录件）

> 来源：reviewer agent `a471de0550d377da3` 于 2026-08-07 的完整返回正文。该 reviewer 的只读环境无法写入主实施树，因此主会话逐字转录其结论；候选基线为 `1d24d9bf..3cd33f48`。

评审范围：Task 1 prerequisite 两笔＋Task 1b 七笔、51 个变更文件及 brief／architecture／report／progress／full diff。总体 verdict：**Spec FAIL；Quality CHANGES_REQUIRED；存在 blocker；blocker 数量：1**。

已读取／执行证据：Task1b 核心测试 61 pass、typecheck 通过、旧 canonical performance gate 隔离运行 3 pass；但既有 provenance 回归测试稳定 2 fail，完整 backend 本次为 6228／6240 pass，不能归因成仅有旧性能 gate。

[blocker] `/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71/src/lib/pipeline/stream/response-processor.ts:254`、`/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71/src/lib/transport/parsed-sse-frame.ts:49` — direct projection 重建 plain object，丢失 `refusal-recovery` Symbol；同时所有 fresh rewrite output 都被重新包成 parsed provenance，synthetic frame 会继承伪 `idField`。现有 S8 end_turn／error 测试分别得到 0 和 false。应让 rewrite action 区分“保留 parsed wrapper”与“constructed synthetic plain frame”，并显式转移独立 synthetic origin。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71/src/lib/pipeline/sse-encoder.ts:15-38` — encoder 把多行 `event`／`id` 编成重复字段，却把 projection 记为含换行字符串；生产 parser 实测 wire 最终为 `event:"b", id:"j"`，projection 却为 `"a\nb"`／`"i\nj"`。无效 retry 也会写入 projection、却被 wire parser 忽略。应仅允许 `data` 多行，对 `event`／`id` CRLF 与非法 retry 拒绝或按真实 SSE 语义投影，并用独立 WHATWG oracle 校准。

[major／假绿] `/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71/tests/pipeline/generation-runtime-baseline.http.test.ts:269-275` — “reset”把裸 `id:` 放在 `[DONE]` 上，而 `/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71/src/lib/pipeline/generation/candidate-race.ts:40` 会丢弃 `[DONE]`，故 route gate 从未验证 reset 到达 sink／client History。应改为第二个普通 data event，并逐字节断言裸 `id:`。

[minor／结构怪味] `/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71/tests/helpers/sse-write-stream.ts:3-19` 与 `tests/pipeline/client-sink.unit.test.ts` 重复同一 decoder，且两者都错误地 join 重复 `event`／`id`，形成同源 oracle。应集中一个经生产 parser 或第三方标准实现校准的 decoder。

双向判据：false-green 已由 reset route 与 multiline decoder 证实；false-red 方面，旧 timing-ratio gate 本次隔离为绿，后续 `30134734..d6961943` 确已改成 deterministic gate，因此不能拿旧 gate 红阻断本任务，但同样不能用它掩盖上述确定性回归。

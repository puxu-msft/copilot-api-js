# 每请求 CPU 降低：进度

## 当前基线

- 被测 commit：`db4d16efbb9d44b74e4a573e67ba0f74df7b1ce5`，隔离 worktree：`/home/xp/src/copilot-api-js/.worktrees/per-request-cpu-reduction-43045809`。
- 基线 harness 位于 `/tmp/cpu-profile-43045809/`：655 条消息、28 tools、1,543,331 B 请求体、hook mock 142 upstream SSE 帧，`/proc/<pid>/stat` user+system ticks 计量 10 个 warm 后请求。
- 既有基线：5.04 CPU-s／10 请求，即 504 ms/请求。6-frame counterfactual 是 1.58 CPU-s／10 请求，即 158 ms/请求。

## 已确认的契约与计划

1. `RawHttpRequest.originalBodyForHistory` 改为调用者交付的私有 immutable snapshot；三个 codec 不再重复 clone。HTTP handlers 负责 snapshot；Responses WebSocket 补其此前缺少的一次 clone，因为 `wireBody` 与原始 payload 共享嵌套引用。
2. `raw.body` fallback 没有私有所有权保证，保留 clone，避免静默退化为 mutable History inbound record。
3. `DEEP_CLONE_FIELDS`、candidate fork 和 operation-record 的 clone/freeze 先分别核验不变量和写者；本轮不反射式弱化。

本文件随实验更新；不把尚未测量的收益写成结论。

## 实施与复测

- 实现：新增 branded `HistoryBodySnapshot` 和唯一构造器 `snapshotHistoryBody()`；codec 边界用 `historySnapshotBody()` 拒绝伪造对象。Anthropic HTTP 使用其唯一 snapshot；Responses WS 也使用它，保持 WS 的总 clone 数不变。三个 codec 在有 snapshot 时直接存入 History；缺少 snapshot 时继续 clone `raw.body`，因为它没有私有所有权保证。
- 正向/负向守卫：`tests/pipeline/history-body-snapshot.unit.test.ts` 证明源对象改写不影响 snapshot，并证明无 brand 的伪造 alias 被拒绝；codec model-wiring tests 改为走真的 constructor。焦点 14 tests 全绿；`bun run typecheck` 全绿。
- CPU after：当前 worktree，4250，2 warm-up 后 10 个 655-message/142-frame 请求：229 ticks / 100 Hz = 2.29 CPU-s = **229 ms/request**；wall p50 162.4 ms，min-max 135.3-221.7 ms。旧 harness 的 before 是 504 ms/request（不同 pre-change commit；因此是方向性 A/B，不把 55% 写作精确稳定收益）。
- `bun run test:backend` 已运行但返回 1；其聚合输出被 coverage 表淹没，末尾显示一个 14-pass 子批次而未给出失败 test 名。本轮未将其标记为通过，需下一轮抓取 parallel runner 每个 child 的失败文件后修复或归因。

## 其余 clone/freeze 的不变量判定

| 位置 | 守护的不变量及潜在写者 | 判定 |
|---|---|---|
| `anthropic/request-preparation.ts:568` | `DEEP_CLONE_FIELDS` 使 upstream wire 不与 client/history/后续 rewrite 的嵌套对象别名；S3 request rewrite、retry 和 provider adapters 都可能重写 wire body。 | **必要**，不能删；若未来有 immutable wire representation，才可把它收敛为 ingress 后的单次 copy-on-write。没有反向证据支持弱化。 |
| `pipeline/generation/candidate-state.ts:50-75` | hedge/retry candidates 的 `body`、`prepareHints` 是 mutable；并发 candidate 若共享会互相覆写。文件头 contract 明确 request scope 才能共享。 | **必要**；不应就地 freeze，因为 candidate 需要改写。可长期改为 persistent COW body，但须用并发 hedge mutation 对照验证；本轮不动。 |
| `model-operation-record.ts:602-614,815-832` | History record 在 terminal 后 immutable，且 richest-data-flow 要保留完整 arena/frames；`buildSnapshot` 复制 mutable arrays，`freezeCapturedValue` 避免录入对象随后被调用方改写。 | **必要但可收敛**：append-only sealed arena / persistent snapshot 可消除 terminal 全量 array rebuild；必须先证明发布原子性及 History byte/semantic contract，不能删或简单 Worker offload。 |

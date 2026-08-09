# A3 六条 finding 合并态独立复评

- **评审范围**：`master@9fad0bdfc2d0031e723360da44d1a668f2aa028a` 的 A3 合并态；当前 worktree `HEAD=371d4409ab769d28a38648baf7c231f75b176b9c`，相对目标代码仅多出 HANDOVER 与本轮简报文档。
- **已读取／执行的证据**：完整读取派活简报、冻结 spec、HTTP→queries→sidecar→native 最终代码及相关测试；在 `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5` 实跑 `bun test tests/history/search/`、`bun test tests/history/history-api.it.test.ts`、`supersede-probe.ts`、`segment-probe.ts`，均绑定并打印该物理路径；两组测试退出 0。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。另有 5 条 major。
- **C1–C8 结论**：C1、C2、C3、C7 未成立；C4、C5、C6、C8 与最终代码及实跑证据一致。C7 的正确裁决是“保留并补可达覆盖”，不是“不可达但保留”。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/lib/history/queries.ts:367-380,390-450` — C1 仍未冻结 overlay 的持久化归属，`freezeHistorySearchTarget` 只冻结 sidecar target。
证据／失败场景：recent row 在 371–380 被收入 overlay，若在 390 的 `await listSearch` 期间落盘，它不在 frozen target/sidecar total 中；449 却按 await 后的 live DB 判它已 persisted，于是 entries 含该行而 transient count 不含它，仍可得到 `entries.length=1,total=0`。
修复建议：在同一 pre-await 快照冻结每个 overlay ID 的归属并在合并、total、cursor 全程复用；用 deferred `listSearch` 在窗口内提交该 row 的回归与 mutation 对照。

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/lib/history/v3/summary-store.ts:387-418` — C2 所称“唯一判定源”被 persisted stats 的第二份、且语义更弱的 CASE 实现破坏。
证据／失败场景：`lifecycle-state.ts:67-75` 规定 active state 恒为 `none`、仅 `state===undefined` 才 fallback；这里 398–408 却把任意非 terminal state 按 `response_success` 计 success/failure，故同一 streaming summary 在 overlay 与 persisted stats 中分桶不同。怪味类型：重复语义实现；处置：本轮修。
修复建议：让 SQL CASE 严格派生自同一 lifecycle 契约，仅 `state IS NULL` fallback，并以同一样本比较 overlay 与 persisted stats 的双向结果。

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/routes/history/handler.ts:56-58,76-87` — C3 的 enum 校验会 false-red 拒绝合法 `openai-embeddings` endpoint。
证据／失败场景：canonical producer 写 `openai-embeddings`（`src/routes/embeddings/route.ts:58`），冻结前置要求也明确补齐它（`docs/spec/2026-07-28-history-read-path-core.md:325`），但 `EndpointType`（`src/lib/history/core-types.ts:2`）和 `ENDPOINTS` 都遗漏；`/api/entries?endpoint=openai-embeddings` 因而返回 400。
修复建议：从完整的 canonical endpoint 类型生成校验集合并补该值，增加 producer 值逐个能通过 list 校验的正控。

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/routes/history/handler.ts:89-100,114-121` — C3 的数字验证与实际解析不是同一语义，错误状态可通过且正确含义会被改写。
证据／失败场景：校验用 `Number(raw)`，消费却用 `Number.parseInt(raw,10)`；实跑显示 `1e2` 被校验为 100、消费为 1，故 `from=10&to=1e2` 通过 `from<=to` 后实际变成 `10>1`，`limit=1e2` 也静默从 100 变 1。
修复建议：边界只解析一次形成 normalized DTO，验证与下游复用同一数值；正负控覆盖指数、十六进制、小数、前导零和安全整数边界。

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/native/history-search/src/lib.rs:555-577` — C7 的“实测不可达”前提已被本轮指定探针直接推翻，现有测试仍未覆盖承重分支。
证据／失败场景：实跑 `supersede-probe.ts` 产生 `74b0…410.del`，live segment 报 `maxDoc:199,deletes:{num_deleted_docs:1,opstamp:410}`；而 `tests/history/search/daemon.it.test.ts:228-247` 仍以单文档 segment 被整段丢弃的 fixture 声称不可达，禁用 alive 检查仍会假绿。
修复建议：保留 alive 分支；把 200-document supersede 形态固化为 native 回归并确认移除 576–578 会变红，同时更正 README 与测试注释的过时断言。

## 合并态接缝与性能判据

- 完整路径的关键交接为 `handler.ts:105-129` → `queries.ts:361-460` → `daemon.ts:576-625` → `lib.rs:480-733`；C1 的 pre-await overlay 与 post-await DB 交界、C3 的 validator 与 parser 交界是本轮确认仍开放的集成缝。
- C5 的 exact total、tuple order、双向 keyset、hasOlder/hasNewer、invalidCursor，以及 C6 的 pushdown⊇post-filter 不变量，在最终代码与 native focused tests 中未发现新的 blocker/major；空字符串不下推（`lib.rs:449-471`），`limit=1` 与 cursor 边界有正样本。
- `exp/history-search-list-perf/README.md:76-83` 对真实语料、多 segment、删除密集、并发及“非门禁”的限制说明诚实；性能数字本身不构成正确性证明。本轮不据单次 benchmark 断言额外性能缺陷。

## 主观建议

无。

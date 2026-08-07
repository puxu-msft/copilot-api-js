# Task 8 progress：in-memory ordered GOAWAY ledger

## 基线与状态

- BASE：`1d24d9bf14d36a0e3f53b200695b49a424d33191`。
- `git merge-base --is-ancestor 1d24d9bf HEAD` 已于开工时返回 exit 0，无需 fast-forward。
- RED checkpoint 已新增唯一测试：创建 ledger 后取得一个 dispatch lease，在无 event／无 violation 时 `freezeAtTerminal()` 必须返回 Task 7 `GoawaySnapshot` 的 ordinary zero-event 形状与 `operationLease: null`。
- RED：`bun test /home/xp/src/copilot-api-js/.worktree/agent-a249668f4c8be26c4/tests/transport/http2-goaway-ledger.unit.test.ts` 为 0 pass、1 fail、1 error；精确失败是 `Cannot find module '~/lib/transport/http2-goaway-ledger'`。
- GREEN 1：新增只满足首测的最小 `SessionGoawayLedger`／dispatch source 后，同命令为 1 pass、0 fail；typecheck exit 0。
- RED 2：ordered-event 测试先因 `RegisteredGoawayEvidence` export 缺失而 0 pass、1 fail、1 error。
- GREEN 2：实现 captured evidence 与 append-only events 后 targeted test 为 2 pass、0 fail；typecheck exit 0。覆盖 first／decrease／equal／increase order、same digest 不合并、visible increase 的 `appended-protocol-error` 与 violation。
- RED 3：ownership tests 为 2 pass、3 fail，精确缺失 `closeSessionOwner()` 与 dispatch `release()`。
- GREEN 3：session owner／dispatch／operation 共用单一 refcount，append 发布后消费 evidence、发布前失败不消费；session close 后 operation lease 仍读 bytes，最后 release 归零；duplicate freeze／release 与 release 后读均 fail loud。Targeted test 为 5 pass、0 fail；typecheck exit 0。
- RED 4：shared violation tests 为 5 pass、3 fail，精确缺失 `recordUnattributedProtocolError()`。
- GREEN 4：shared one-shot first reason wins，后到返回 `already-recorded` 且不覆盖；stream-first／session-first 双向可区分 reason；zero-event error 冻结为 `unavailable-at-source`，ordinary zero-event 保持 not-observed，observed event 保留 violation。Targeted test 为 8 pass、0 fail；typecheck exit 0。
- RED／GREEN 5：补 `appendUnavailable`、Task 7 `GoawaySnapshot` 类型构造证明与 per-dispatch immutable prefix。新增 test 先因 `appendUnavailable` 缺失而 9 pass、1 fail，完成后为 10 pass、0 fail。
- 四项 exact mutation 均命中目标机制并经 `git apply --reverse --check` 后恢复：fan-out 9 pass／1 fail；zero-event violation drop 8 pass／2 fail；owner close 早丢 bytes 9 pass／1 fail；duplicate operation release 9 pass／1 fail。每次恢复后最终套件 10 pass／0 fail。
- 收口验证：targeted 10 pass／0 fail；`bun run typecheck` exit 0；目标 ESLint exit 0（仅 `baseline-browser-mapping` 既有提示）；`git diff --check` exit 0。
- 工作树内报告 `.superpowers/sdd/task-8-report.md` 已更新完成，但按约定不纳入功能提交。Task 7 Minor receiver mutation 保留为 Task 10／11 gate，本任务未改 AST guard。

## 已完成

- 阅读 Task 8 brief、readiness、spec §5.3～§5.5、Task 7 唯一 schema `src/lib/transport/http2-observation-types.ts` 与计划 Task 8。
- 确认边界：只新增 `src/lib/transport/http2-goaway-ledger.ts` 与 `tests/transport/http2-goaway-ledger.unit.test.ts`；不改 production wiring 或 Task 7 schema。
- 确认核心合同：单一 refcount；append 成功发布才消费 evidence；duplicate freeze／release fail loud；first violation reason wins；same digest 不合并 ordered events；zero-event 三态严格。

## 未提交文件及在途意图

- `.superpowers/sdd/task-8-report.md`：worktree-local 实施证据报告，后续逐步补充 RED／GREEN、mutation、验证、ownership proof、结构怪味与三方向反思。
- `src/lib/transport/http2-goaway-ledger.ts` 与对应 unit test：当前已完成 ordered append 及 owner／dispatch／operation ownership slice。
- 当前没有其他未提交产品源码或测试。

## §6b first-parent 对账

从 BASE 到收口前 HEAD 的 first-parent lineage 为：`9b4178e3` progress checkpoint → `dcfc889a` RED 意图澄清 → `98cf30ef` test-first RED → `aef8d661` ordinary zero-event GREEN → `169beb26` ordered events → `6c33380f` ownership/refcount → `9290b6c1` shared violation。每个 commit 均可从本文件对应 RED／GREEN 条目恢复意图；最终收口 commit 将补齐 unavailable event、mutation 与验证证据。

## 剩余项

- Task 8 实现、测试、mutation 与验证均完成；待提交最终收口 commit。
- Task 10／11 必须补 Task 7 Minor receiver mutation gate；本 Task 按边界未改 AST guard，也未接 production wiring。

## 已作废路子

- 不复制 Task 7 的 serializable union／generic source／result。
- 不复用 raw manager 或 h2 creation lease 的 duplicate-release 幂等语义。
- 不在 GOAWAY append 时向每个 dispatch fan-out snapshot。
- 不因 session owner close 提前销毁仍被 dispatch／operation lease 引用的 evidence bytes。
- 不在本 Task 接入 `http2-client`、scheduler、RequestContext、terminal bus、writer 或 production session wiring。

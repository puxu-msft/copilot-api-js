
## 总体 verdict

- Verdict：**修复 MAJOR 后可进入下一阶段**。
- BLOCKER：0。
- 事实性发现计数：MAJOR 1、MINOR 0、NIT 0。
- 主观建议：0。
- 评审结束时共享 HEAD 已前进到 `63568feeddf6254b0108f28e3f4251e1a2c140f2`；`b9b5895b..63568fee` 只改三份 docs（`docs/coding-conventions.md`、progress snapshot、deferred backlog），未触及本报告评审的生产/测试接缝，因此上述代码结论仍锚定 `b9b5895b` 且未被相关路径变化推翻。

## 结构怪味扫描

- 扫描范围：30 余个 remerge 决议文件，重点覆盖 `src/lib/context/*`、`src/lib/history/*`、`src/lib/pipeline/*`、`src/lib/transport/*`、Responses→CC translators 与对应 tests。
- 判据：重复实现、职责错位、抽象泄漏、同一不变量存在一强一弱两套实现。
- 发现：`src/lib/history/state.ts:100-143` 的 lifecycle 职责组合不完整，已作为 MAJOR 记录；其他重点路径的共享 primitive（canonical frame projection、usage mapper、response processor、HTTP2 terminal recorder、snapshot wrapper）均位于共同基座，未发现需另列的结构怪味。

## 三方向反思

1. 更好的内部替代：History re-init 应复用已有 admission `pause()/waitForQuiescence()` 与 terminal drain primitives，不能再造另一套 pending-state gate。
2. 判据判别力：现有 tests 对 canonical frame、snapshot、HTTP2、WS terminal 均有真实生产接缝覆盖；对 History re-init 的在途 publication 缺正反样本，故没有用“测试绿”否定 MAJOR。
3. 第三方方案：本轮问题是项目内部 lifecycle/SQLite transaction wiring，没有边界清晰且能替换该协议的成熟第三方库；不建议引入新依赖。


## [MAJOR] `src/lib/history/state.ts:100-143` — `initHistory` 重入只协调 summary backfill，未协调 terminal persistence lifecycle

- **现象：** `initHistory()` 开头只停止并等待 V3 summary backfill，随后立即清空 in-flight/recent-terminal overlay；enable 路径又直接打开数据库、替换 admission sink，并在最后替换 terminal-bus subscriber。该序列没有先阻止新的 History reservation／terminal publication，也没有等待旧 terminal subscriber 与 V3 writer 排空。因此，“backfill 已停止”不等于“旧 History lifecycle 已静止”。
- **根因：** 已定。合并把分支侧的 `startV3SummaryBackfill(getDatabase())` 与 master 侧的 admission→terminal sink→terminal-bus 路径组合进同一个 `initHistory()`，但重入协议仍只覆盖 backfill；terminal persistence 的 pause、quiescence、unsubscribe 和 drain 没有纳入 DB/sink 切换临界区。
- **代码证据 1：** `src/lib/history/state.ts:100-108` 仅执行 `stopV3SummaryBackfill()`、`await drainV3SummaryBackfill()`，随后便调用 `clearInFlight()` 与 `clearRecentModelOperationTerminalsForTests()`。
- **代码证据 2：** `src/lib/history/state.ts:124-143` 依次执行 `openDatabase()`、migration/recovery、`startV3SummaryBackfill()`、`admission.replaceTerminalSink()`、旧 subscriber unsubscribe、新 subscriber subscribe；该区间没有 `admission.pause()`、`admission.waitForQuiescence()`、`drainModelOperationTerminalSubscribers()` 或 `drainV3Writer()`。
- **代码证据 3：** `src/lib/history/worker/admission.ts:182-197` 已提供 `pause()` 与 `waitForQuiescence()`；`src/lib/history/v3/terminal-bus.ts:71-74` 已提供 `drainModelOperationTerminalSubscribers()`；`drainV3Writer()` 已在 `shutdownHistory()` 使用（`src/lib/history/state.ts:217-220`）。这些现成 primitives 证明项目已有完整切换所需的分层能力，只是 `initHistory()` 重入路径未接线。
- **代码证据 4：** terminal publication 会先进入 transient overlay，再调用异步 subscriber（`src/lib/history/v3/terminal-bus.ts:35-47`）；`clearRecentModelOperationTerminalsForTests()` 最终清空 pending/acknowledged maps（`src/lib/history/recent-terminal.ts:55-58`）。旧 publication 稍后 settlement 时，`settleTerminalDurability()` 若发现 `pending.get(operationId) !== publication` 会直接返回（`src/lib/history/recent-terminal.ts:27-34`）。
- **运行／搜索证据：** focused merged-seam tests 得到 `173 pass / 0 fail`，第二组 integration tests 得到 `91 pass / 0 fail`；但现有 `tests/history/v3/migrations-wiring.it.test.ts:117-128` 只把 backfill 横跨 `initHistory(false)`，没有把已发布但未持久化的 terminal 横跨 `initHistory(true)`。因此这些绿结果不覆盖本失败窗口。
- **可观察错误行为：** 若 publication P 已进入 recent-terminal pending overlay、其旧 subscriber/write 尚未完成，此时重入 `initHistory(true)`，P 会先从 overlay 消失；旧异步工作随后即使完成，durability settlement 也因 identity guard 被忽略。接手方或用户会看到 History 项在持久化窗口内无故消失、durability pending/failed 状态缺失；若 DB path 在重入中变化，旧 writer 还可能与 singleton DB 的 close/reopen 交错，使 terminal 写失败或写入归属不明确。已绑定但尚未 publish 的 reservation 本身不会被 `clearRecent...` 删除；本发现不声称“所有 reservation 都丢失”。
- **建议处置：** 由 `gpt-souls:implementer` 把 `initHistory()` 的重入改成完整 lifecycle transition：先在 `src/lib/history/worker/admission.ts` 的 controller 上调用 `pause()` 阻止新 admission，并用 `waitForQuiescence()` 等待已保留工作的明确切换点；随后 unsubscribe terminal subscriber，调用 `drainModelOperationTerminalSubscribers()` 与 `drainV3Writer()`，再停止／drain summary backfill并切换 DB/sink，最后重新 subscribe 并 `resume()`。具体顺序必须同时保证“允许已获 reservation 完成”与“禁止 publication 落入无 subscriber 窗口”，不能只机械加入 pause。
- **回归测试建议：** 增加确定性 IT：让 terminal publication 停在 subscriber/write 未完成处，执行 `initHistory(true)` 重入，再释放写入；断言记录不丢、不双写、overlay durability 最终结算、admission 最终 quiescent。正控证明无重入时同一 publication 正常落盘；负控让旧实现稳定复现 transient disappearance 或 settlement 丢失。


## 更正：MAJOR 的归属与本次合并放行边界

1. **接受归属证伪。** 该 lifecycle 缺陷是 master 侧 `57208559` 已完整存在的既有缺陷，不是 `ca5f4cf7` 合并引入的回归。master 原有 `initHistory()` 已具备 `clearInFlight()`／`clearRecentModelOperationTerminalsForTests()` → `openDatabase()` → `replaceTerminalSink()` → 替换 subscriber 的窗口，且没有 admission pause/quiescence 或 terminal subscriber/writer drain。本次合并相对 master 仅增加 `stopV3SummaryBackfill()`、`await drainV3SummaryBackfill()` 与重新 `startV3SummaryBackfill()`，是把既有不完整重入协议多覆盖一条 backfill lifecycle，没有新增或扩大已证失败窗口。原文“根因：合并把两侧路径组合后造成协议不完整”的归因错误，以本更正为准；正确根因是 master 既有 `initHistory()` 重入合同从一开始就没有覆盖 terminal persistence lifecycle。

2. **本次合并 verdict 相应改为“可进入下一阶段”。** 本条仍是实际影响达 MAJOR 的长期正确性缺陷，但不计入本次 merge delta 的阻断项：阻止这条合并线不会消除 master 上同一个失败窗口，也不能使目标主线更正确；反而会把与该缺陷无因果关系的本分支改动扣留。最终计数更正为：本次合并范围内 BLOCKER 0、MAJOR 0；另记录 master 既有 MAJOR 1。该条不能被忽略或以 ROI 暂缓，应把完整证据链、`admission.pause()`／`waitForQuiescence()`、`drainModelOperationTerminalSubscribers()`、`drainV3Writer()` 清单及确定性回归测试建议作为独立缺陷写入 `docs/todo/deferred-backlog.md`，再由独立实施批次修复。此结论取代报告开头“修复 MAJOR 后可进入下一阶段”及“MAJOR 1”的旧 verdict／计数。

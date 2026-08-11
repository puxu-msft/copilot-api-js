---
slug: impl-1b
base: 90e777bc1b42eef2738e12abfff487f9ac7c97ef
branch: worktree-history-worker-batch-1b-resume
worktree: /home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session-0ff74836
session_id: 0ff74836-c889-4e6b-9aaa-72ba9fe985fd
predecessor_session_id: 32630e1d-bf0b-4a6c-baa8-80afb3446c1e
status: batch-1b-integrated-master-d3b4ac77-superseded-by-plan
continuity: tightly-coupled
continuity_reason: route admission, terminal publication, shutdown and pending overlay share one reservation lifecycle; splitting before the shared contract is green would force each executor to reconstruct and potentially diverge that lifecycle.
---

> **状态：已完成并停止更新。** Batch 1b 已于 2026-08-08 fast-forward 合入 `master@d3b4ac77`；活跃状态写入权已转交正式计划 [`docs/plan/2026-08-07-history-persistence-worker.md`](../plan/2026-08-07-history-persistence-worker.md) 的 Batch 1b 状态行。本文件保留接力、验证与作废路线的历史证据。

## Context-window 终态接力

- 来源 transcript：`/home/xp/.claude/projects/-home-xp-src-copilot-api-js/32630e1d-bf0b-4a6c-baa8-80afb3446c1e.jsonl`；原会话于 2026-08-08T10:59:41Z 明确返回 `input exceeds the context window`，旧 worktree `/home/xp/src/copilot-api-js/.worktree/history-worker-batch-1b` 自此只读取证。
- 已提交单元按 patch-id 等价重放：`8f05e565` → `f8b9c19e`，`31da037d` → `17c05e59`；新分支先快进到本地 `master@90e777bc`，未移动或改写 `master`。
- 旧 tracked WIP 冻结 patch：`/home/xp/.claude/jobs/0ff74836/tmp/history-worker-batch-1b-wip.patch`，SHA-256 `018da448e8f2c9dc5250ab86d055ad000c670dc82b40a90aa0bb6c199726ce15`。47 个文件由 `git apply --3way` 恢复；`src/lib/context/activity-summary.ts` 与 master 同期 attempt-snapshot 改动重叠，已手工保留双方语义。
- 6 个旧未追踪文件逐文件 no-clobber 复制并核对 SHA-256：`recent-terminal.ts`、`terminal-publication.ts`、`http-admission.ts`、`legacy-terminal-sink.ts`、`status.ts`、`history-terminal-publication.ts`。旧树没有被清理、恢复或写入。
- 接力当时尚待复验：旧会话最后已观测 direct-driver fixture 集 12 pass／0 fail、typecheck 绿，但 `shutdown-mid-stream.http.test.ts` 仍失败；性能阈值 25 轮输出未在旧 transcript 中闭合。这些旧通过性结论当时未被直接继承；本 worktree 的重新运行、根因修复与最终闭合证据见下文“实现与接力后验证”。

## 剩余项

- [x] 冻结并验证 HTTP／Responses WS 生产入口矩阵；管理面、History 查询与 dry-run 不受 admission 阻塞。
- [x] 建立 operation-owned、一次性 seal/transfer 的 `ModelOperationTerminalPublication` 与 raw attachment 接缝；terminal bus subscriber 是唯一 `acceptTerminal()` 调用者。
- [x] 扩展 context／lightweight reservation 生命周期：创建 operation ID 后 bind；绑定前失败 release；绑定后、publish 前失败走 `failBeforeTerminal`。
- [x] 安装 no-throw `LegacyHistoryTerminalSink`，将旧 writer outcome 转为 admission terminal outcome。
- [x] shutdown Step 1 停止新 admission waiter，并在 History close 前 drain waiter／reservation barrier。
- [x] pending durability 全量 overlay 与独立 256 acknowledged-recent cache；status／metrics／telemetry 接线。
- [x] 定向门禁、两方向 mutation 正控、backend、独立复审到 0 blocker／major。
- [x] fast-forward 合入 `master@d3b4ac77`，并回填正式计划的最终完成 SHA。

## Red 阶段证据

- terminal publication／pending overlay：`pending-overlay.it.test.ts` 初跑因 `~/lib/history/terminal-publication` 不存在而 0 pass／1 fail；测试同时冻结一次性 raw attachment owner、完整 publication subscriber、legacy sink no-throw/exactly-once、512 pending 全量可见和 ACK 后独立 256 recent cache。
- shutdown：`admission-shutdown.unit.test.ts` 为 0 pass／2 fail；事件序列分别缺 `admission-stopped` 和 `admission-drained`，证明 Step 1 stop 与 finalize barrier 尚未接入，非 timer 假红。
- HTTP：`admission-wiring.http.test.ts` 两条现有生产请求均直接越过 controller，观测 `waiting=0`；真实行为 oracle 要求 capacity 满时 count_tokens pending、liveness 仍 200、client abort 移除 pre-context waiter。
- Responses WS：纯 fake `UpgradeWebSocket` 驱动生产 `onOpen/onMessage` 成功，当前观测 `waiting=0`；目标是每个 `response.create` 独立 acquire，socket close abort waiter，不启动任何端口。
- 入口矩阵：AST 判据正样本与 Azure 不得 double-acquire 两条通过，八个 production operation owner 因第一个 CC owner 0 次 wrapper 而红（2 pass／1 fail）；判据忽略注释与字符串。
- status／metrics：`status.unit.test.ts` 因模块不存在红；管理 `/api/status` 的 `history_persistence` 为 undefined；Prometheus 用例缺全部 History process-global families。
- telemetry：独立 `history_admission_wait_ms` 用例因 histogram undefined 红，管理请求未提供该字段时“不观测”正样本绿（1 pass／1 fail）。
- `bun run typecheck` 最终只剩 10 个预期红项：`http-admission`／`terminal-publication`／`legacy-terminal-sink`／`worker/status` 四个缺模块或 API，加 manager/lightweight `historyReservation`、`RequestContext.historyAdmissionWaitMs`、terminal bus subscriber 仍接裸 record、metrics 第六参数和 telemetry input 字段；fixture 类型噪声已归零。
- Batch 1b raw attachment 仅冻结空 commands，使用显式 raw-disabled descriptor；plan 把 active descriptor/config revision 状态机放在 Batch 3a，本阶段不得提前接该机制。

## 实现与接力后验证

- Batch 1b 生产接线已恢复到新基线并通过 plan 定向集合：42 pass／0 fail；`precontent-recovery-matrix` 的两个 terminal subscriber 已迁为显式读取 `publication.record`，该文件 42 pass／0 fail；`bun run typecheck` 绿。
- 旧会话未闭合的性能疑点已复验：`bun test tests/history/in-flight-summary-memo.unit.test.ts --rerun-each 25` 为 100 pass／0 fail（单文件 25 轮、当前分支基于 `master@90e777bc`）。这只是用户要求的粗粒度安全上限，不升级为复杂度证明。
- `shutdown-mid-stream.http.test.ts` 的首轮红先暴露 stop signal 泄漏；仅在该文件 afterEach 清 signal 后，又暴露 Responses／Gemini 的 reservation 永不 release。根因在共享 fixture 顺序：`resetTestRuntime()` 先 `initHistory()` 让 terminal subscriber 捕获旧 admission，随后 `useIsolatedRuntime()` 的 RESETTERS 才清 registry singleton；下一请求绑定新 controller，而 publication 送旧 controller。修复移到 `tests/helpers/test-bootstrap.ts`：先重建 admission signal／singleton，再 `initHistory()` 重接 subscriber；两项从后置 RESETTERS 改为 resetTestRuntime-owned EXEMPT。验证：shutdown 单文件 3 pass／0 fail、fixture+resetter guard 8 pass／0 fail、`shutdown.unit + shutdown-mid-stream + query-forwarding` 配对 59 pass／0 fail。
- 结构怪味：`tests/helpers/isolated-fixture.ts` 与 bespoke shutdown fixture 曾重复承担 admission reset，且后置 reset 与 `initHistory()` 重接线顺序相反（职责错位／双源 reset）。本轮已修到共享 `resetTestRuntime()` 基座；未留 backlog，因为所有复用者都会踩且修复已被现有配对测试覆盖。
- 首次接力后全 backend 为 6681 pass／5 fail。`summary-query-performance` 的真实失败是前序 pending/recent overlay 让 `totalRequests=768≠512`，不是 wall-clock 阈值；该自管 DB fixture 现显式清两个 overlay。三个 shutdown HTTP／durability失败来自 bespoke fixture 的文件首测未先 `resetTestRuntime()`，以及磁盘 DB fixture 未在 `initHistory()` 前重建 admission。
- Responses WS 的最后一个超时经起始／卡点 snapshot 探针定位：起始 `reserved=0`，卡点 `reserved=1/unacked=0` 且 context manager 无 active operation，说明 terminal publication subscriber 被清空。根因是 `useIsolatedRuntime()` 在 `resetTestRuntime()` 已通过 `initHistory()` 重接 production subscriber 后，又从后置 RESETTERS 调 `resetModelOperationTerminalBusForTests()` 把 subscriber 清掉。现 terminal bus 与 admission 均在 `resetTestRuntime()` 的 `initHistory()` 前重置，并从后置 RESETTERS 移除；WS 正常请求→shutdown 配对 2 pass／0 fail，整文件 14 pass／0 fail，fixture+completeness 8 pass／0 fail，typecheck 绿。临时诊断 probe 已全部撤销。
- 隔离修复后全 backend 为 5630 pass／0 fail（16 shards，7282 executed，30 skipped，78.22s；`bun run test:backend`，当前提交 `1c54119f`）。两项 exact-patch 正控均命中目标机制并精确恢复：①移除 Chat Completions `withHistoryAdmission` 后 architecture test 报该 owner 0≠1（2 pass／1 fail）；②移除 shutdown Step 1 `stopAdmission` 后 ordering test 缺 `admission-stopped`（1 pass／1 fail）。恢复后合并目标集 5 pass／0 fail，两个生产文件无 diff。
- 最终评审期间本地 master 合入首信号无损排空重写（最终 merge parent `master@44457047`），与 Batch 1b 的 `src/lib/shutdown.ts`、两份已退役 shutdown-abort 测试等路径重叠。语义合并以新规格 `docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md` 为权威：保留 lossless operation drain，Step 1 只拒绝尚未创建 context 的 admission waiter，canonical finalizer之后／token与History close之前 drain admission；不复活已删除的主动 abort 测试。合并态 typecheck绿，shutdown/admission/h2/rate-limit/architecture 交界集合 49 pass／0 fail。
- 三路独立评审首轮共报1 blocker／3 major，全部采纳（C），处置与证据见 `docs/tmp/2026-08-08-history-worker-batch-1b-review-dispositions.md`：①四codec在context创建后立即发布给`getContext()`，parse异常可settle并释放reservation；②统一pending／ack-recent／DB overlay覆盖list／stats／sessions／status，三源按operation ID去重；③饱和controller动态覆盖7个HTTP operation入口与5个豁免表面，Responses WS保留真实饱和测试；④新增acquire→bind/release handoff barrier，manager先发布registry再bind，shutdown在首次registry snapshot前drain handoff。整改联合验收91 pass／0 fail、14 files、289 assertions，typecheck绿；生命周期与shutdown reviewer复审均为0 blocker／major。
- Overlay／判据 reviewer复审又抓到一个真实假绿：负控请求不存在的`/api/history`，且`status >= 200`让404通过。修为真实`/history/api/entries`、精确200与响应shape；同轮全backend还暴露status改走summary解析后，损坏`summary_json`会漏计canonical operation。`cca342ff`改为overlay IDs＋`v3_operations`排除这些ID后的专用COUNT；原reviewer复审24 pass／0 fail并判0 blocker／major。
- `cca342ff`后的全backend暴露9个失败、归并为三项同根回归：新`overlay.ts`加入core SCC、同步overlay路径未应用message-only search、entry-evidence测试人口baseline未同步。`df0c7bf4`把overlay helper收回既有SCC成员`queries.ts`、对in-flight与recent terminal都从完整entry应用normalized inbound search、机械同步8增2删的测试人口并删除双实现；联合目标集57 pass／0 fail，SCC与discovery守卫均绿，原reviewer按重写新一轮复审后判0 blocker／major。
- 最终backend在`df0c7bf4`连续两次得到`7255 executed／30 skipped`，旧`minimum_executed=7258`已成为合法当前人口过不了的false-red。独立解析两组16份JUnit均得到7285 testcase－30 skipped＝7255 executed；7256负控返回非零、7255正控返回零。`94205e89`仅校准该floor为7255，不改files、allowed_skipped或runner blob。校准后精确计划门44 pass／0 fail、typecheck绿、完整backend 0 fail（16 shards，7255 executed，30 skipped，52.45s）。`pass`汇总在相同executed下会漂移，故不拿它作为人口口径；原reviewer最终复审判可合、0 blocker／major。
- `bun run build`在`94205e89`候选上成功生成`dist/main.mjs`与`dist/history-worker.mjs`；tsdown把动态`bun:ffi`视为external并给出既有warning，不影响构建退出码。

## 冻结的实现边界

- Batch 1b 原始起点为已集成的 `master@cfe78b64`；context-window 接力基线先更新为 `master@90e777bc`，最终又合入含 lossless shutdown 重写的 `master@44457047`。只执行 plan Task 1b，不接 Batch 2a Worker semantic backend、restart policy、SQLite Worker owner 或 query RPC。
- `RequestContextManager.create()` 保持同步；route 在 parse／dispatch 前 await reservation，再显式传入 context／lightweight producer。
- History disabled 返回 no-op reservation；管理面与 dry-run 不创建 reservation，也不产生 admission wait histogram observation。
- admission 继续独占 reservation／waiter 状态；runtime 继续独占 Worker pending envelope／generation；legacy backend 阶段 status 明确 `backend=legacy`，不要求 `admission.unacked === runtime.pendingEnvelopes`。

## 已作废的路子

- 不把 admission 无条件放进 `createRequestContext()`：dry-run 和管理路径也会创建 context，会产生错误背压。
- 不在 route／context／lightweight 各自直接 enqueue persistence：terminal publication 必须只有一个 owner 和一个 subscriber。
- 不复用旧 256 recent cache 承载 pending durability：capacity 可大于 256，提前淘汰会让尚未 ACK 的 operation 从 overlay 消失。
- 不把 `queueWaitMs` 复用为 History admission 等待；它是上游 rate-limit 的不同语义。

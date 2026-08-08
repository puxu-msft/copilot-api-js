---
slug: impl-1
base: 03c3dd131e15b13ac4294fd09fc10a95ad86c04b
branch: history-worker-batch-1a
worktree: /home/xp/src/copilot-api-js/.worktree/history-worker-batch-1a
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session-32630e1d
session_id: 32630e1d-bf0b-4a6c-baa8-80afb3446c1e
predecessor_session_id: 529807d9-28f0-4e56-85c8-03adaf016bb7
status: batch-1a-complete-awaiting-master-integration
---

## Batch 0 完成项

- [x] Task 0 red：协议测试因模块不存在而失败；实现后 3 pass／0 fail，typecheck、目标 lint、`diff --check` 全绿。
- [x] 实现 runtime/history-worker/asset-url/registry 及真 Worker contract tests：12 pass／0 fail，typecheck、目标 lint、`diff --check` 全绿。
- [x] 增加 tsdown alias 双入口并保持 `dist/{main,history-worker}.mjs` 稳定；Bun／Node probes 分别返回 `bun:sqlite`／`node:sqlite` 且 `n=7`，packaged test 自建独立临时 bundle。
- [x] 初轮 review 的 4 个 major 已全部修复。
- [x] 第二轮 F5：强制 terminal 非空、`sequence === lastSequence`、outcome 合法、candidate/dispatch 引用存在、`committedAttempt === committedDispatch`；删除整段实现及分别删除 candidate/dispatch/alias 检查的四轮 exact-patch mutation 均让目标测试按预期变红，恢复后 protocol/runtime 26 pass／0 fail。
- [x] 第二轮 F6：`HistoryWorkerStatusPatch` 只允许 Worker-owned `threadId/selectedDriver/ready/publishedRevision/lastError`；协议逐一拒绝 13 个 main-owned 字段，恶意 `terminalFailed` 帧经 protocol fatal transition 同时 settle pending envelope 与 pending drain request；复审新增的 publication 状态机约束也已闭合：revision 只能在 `[publishedRevision, latestDesiredRevision]` 内单调推进，terminal-failed 后 status 只计 stale、不得复活 ready 或覆盖 sticky fatal。33 pass／0 fail，typecheck／lint 绿。
- [x] 第二轮 F7：pending 状态重算与 observer 通知解耦；ACK/fatal 先完成 callback 与 request settlement 再通知，每个 listener 独立隔离，初次订阅也走同一 helper；main-owned `statusObserverErrorsTotal/lastStatusObserverError` 保留诊断，30 pass／0 fail，typecheck／lint 绿。
- [x] 按用户裁决把 `canonical-performance` 收敛为粗粒度合并安全上限：三个代表性 workload 的整次测试运行须 `<10s`，Bun test 硬 timeout `15s`，CPU／heap 明细只报告；当前正常样本约 0.4s，注入 `0ms` 上限后同一测试红，恢复后 2 pass／0 fail。撤销 `edb66c96` 引入的 production work observer、resetter 与手写 AST SCC guard——用户并未要求复杂度证明，不再维护那套无意义且可绕过的门。
- [x] 最终 merged-state reviewer 发现真实 producer wire blocker：`ModelOperationRecord.attempts` 是 P4–P8 进程内 non-enumerable deprecated getter，canonical JSON／structured-clone wire 按设计不含该字段；协议此前误将其当必填。现以 `CanonicalModelOperationWireRecord = Omit<ModelOperationRecord, "attempts">` 明确 wire 契约、拒绝 enumerable 双份投影，并由真实 recorder→structuredClone→protocol→真 Worker 正样本验收，34 pass／0 fail。
- [x] 闭合最终 reviewer 的 publication ACK revision 对账 major：pending start/update request 保存自身 expected revision；ready/config-applied 先核 request ID、kind、expected revision 与 raw descriptor，再 resolve。A/B config ACK 任意顺序均各自 settle waiter，只有 `revision === latestDesiredRevision` 才发布，迟到 A 不回退 B；39 pass／0 fail、typecheck／lint 绿。`resume-history-worker` 已无冲突合并 `master@9922cb45` 与 feature `c3f15c2c`，复审与最终门均通过，最终 fast-forward 为 `master@03c3dd13`。
- [x] 最终 fast 门暴露 `h2-keepalive-ping` 的 55ms wall-clock 假红：高 shard 负载下只调度一次，并非 scheduler 被 throw 停止。重复／throw 后继续／clear 停止改用事件 oracle；reviewer 指出这会丢失 cadence 判别力后，scheduler 增加窄注入 seam，独立断言精确传入 `15ms`。注入 `intervalMs * 10` 后 cadence test 收到 150≠15 而红、其余事件用例仍绿；恢复后单文件 `--rerun-each 25` 为 100 pass／0 fail，typecheck／lint 绿，原 reviewer 复审 0 blocker／major。
- [x] 最终门：`test:fast` 提交态 4775 pass／0 fail；post-review `test:backend` 首跑非零但工具输出截断了失败项，故未据此猜因；以 `pipefail + tee` 重跑保留完整日志后 5191 pass／0 fail（16 shards，81.17s）。Worker 全套 44 pass／0 fail、typecheck／lint／build 绿，Bun／Node 构建产物 probe 均返回对应 driver 且 `n=7`。

## Batch 1a 剩余项

- [x] capacity=1、FIFO、abort、close、double release、single bind、未知 operation、duplicate terminal 的红绿测试。
- [x] capacity 热调：调大即时放行；调小允许暂时 over-capacity，直到 `reserved < capacity` 才放行；`0 <= unacked <= reserved`。
- [x] `history.persistence_queue_capacity` 配置：strictly positive、默认 256、热更新专用 listener、`config.schema.json` 由生成器更新。
- [x] admission status primitive：capacity/reserved/unacked/waiting/estimatedBytes/overCapacity；不改 HTTP status。
- [x] 正负控、fast/backend 回归与独立 review 整改已完成；复审已达 0 blocker／major，待 fast-forward 合入 master。

## 在途意图

- Batch 0 已 fast-forward 合入 `master@03c3dd13`；当前只执行 Batch 1a primitive，不接 production route、terminal bus、shutdown、overlay、SQLite persistence 或 4141。
- `runtime.ts` 继续只拥有 Worker transport、generation、pending envelope／RPC 与 ACK tombstone；admission 独占 reservation、waiter、operation binding 与 terminal outcome 状态。
- `registry.ts` 继续保持 lazy：Batch 1a 可增加 admission singleton，但 import 不创建 Worker、timer、DB 或 waiter；runtime 与 admission 的构造／测试注入端口保持分离。
- Batch 1a 起点为 `master@03c3dd13`；新 worktree 的 `bun run test:fast` 基线为 4736 pass／0 fail（16 shards，24.28s）。
- Red 阶段建立三份 oracle：admission 状态机、config/state/listener、registry lazy singleton；初始目标命令 0 pass／3 fail，分别因 `admission.ts`、admission registry exports、queue-capacity state export 尚不存在而红。Green 后目标 15 pass／0 fail；Worker regression 50 pass／0 fail；config regression 431 pass／0 fail；resetter/isolation 8 pass／0 fail；最终九文件目标集 489 pass／0 fail；typecheck、精确 lint、`diff --check` 绿。
- 实现中发现 plan 已声明但 Batch 1a 测试原未覆盖的 pause 接缝：pause 前已排队 waiter 必须继续按 FIFO settle，pause 后 acquire 才冻结；先写 2s timeout 红测试，再以 waiter boundary 修复为 8 pass／0 fail。`waitForQuiescence()` 仍独立等待 reservation 清零。
- `failBeforeTerminal` 原实现只 release、丢弃 plan 要求记录的 error；先加 snapshot red，再记录 `preTerminalFailuresTotal/lastPreTerminalError`。admission singleton 与 capacity listener 均登记到统一 `RESETTERS`，避免跨测试泄漏。
- 三项 exact-patch 正控均命中目标机制：acquire `<` 变 `<=` 后 capacity=1 得 `reserved=2/overCapacity=true`；schema positive 变 nonnegative 后 `0` 被接收；删除 registry capacity listener 后 singleton 保持 256≠19。每项均先 reverse-apply check 再反向恢复，恢复后 15 pass／0 fail且工作树干净。
- 最终 fast 为 4102 pass／0 fail。backend 初跑唯一断言失败是 UDS child 负载 test 撞默认 5s，单文件 25 轮为 600 pass／0 fail；曾尝试 test timeout 15s，但在 16 shard 下仍与 `packaged-runtime` hook 一起超时，证明抬 timeout 未治根因，已完全撤回。根因是 committed LPT cache 缺这两个 spawn-heavy 文件、按 median 误分桶；官方 `parallel-test --update unit it http` 刷新 694 个 timings 后，同次 backend 为 5756 pass／0 fail（16 shards，26.80s），UDS guard 零改动。
- 初轮 Batch 1a review 报 2 major，均采纳（C）：① sink 无 outcome 而同步 throw 时不能释放 terminal-unacked reservation；初轮整改保留 pending callback／reservation，记录 `sinkEnqueueErrorsTotal/lastSinkEnqueueError`，正常返回时保存 `messageId`，late outcome 仍是唯一释放点，同步 outcome 后 throw 不反转——该方案随后被第二轮 reviewer 的 throw-before-callback 探针证伪，见下一条；② pending pause barrier 遇 close 必须 reject，不能成功 resolve；现 pause waiter 同时持 resolve/reject，close 以同一 error 拒绝所有重复 pause。两组交错测试先 4 fail，整改后 admission 12 pass／0 fail。两项 exact-patch 正控分别恢复旧 sink-throw release 与旧 pause-close resolve，均只让对应新增测试红；reverse-apply 恢复后 12 pass／0 fail且工作树干净。Post-review 目标集 493 pass／0 fail、backend 5480 pass／0 fail（16 shards，27.12s），typecheck／lint／`diff --check` 绿。
- 第二轮 reviewer 确认 pause-close major 已闭合，但独立探针证明 sink 在保存 callback 前 throw 时会永久占住 reservation：`reserved=1/unacked=1/unackedMessageIds=[]`，`replaceTerminalSink()` 不重投，`acceptTerminal()` 与 quiescence 均不 settle。事实经本会话复跑同形 red test 确认；修法按冻结 spec 与真实 adapter 独立裁决（C）：spec 只要求 Worker crash 后由 runtime generation 重放，现有 `HistoryPersistenceRuntimeImpl.enqueue()` 已把 transport/validation 异常转为 `"failed"` outcome，legacy `enqueueModelOperationWithOutcome()` 也明确 never rejects，因此 `HistoryTerminalSink` 的共同契约收紧为 no-throw + exactly-one terminal outcome，不在 controller 泛化 unknown-acceptance replay。
- 防御性边界仍处理违约 sink：同步 throw 记录 `sinkEnqueueErrorsTotal/lastSinkEnqueueError` 后调用同一幂等 `onOutcome("failed")`，立即释放 reservation；若 sink throw 前保存了 callback，迟到 callback 被 settlement guard 忽略、不会双释放。默认未配置 sink 自身同步回调 `failed`，不再依赖 controller catch；它在回调后返回正整数占位 ID，而同步 settlement 保证该 ID 不会进入 snapshot。三条 red tests 初始均收到 pending sentinel；实现后 admission+registry 17 pass／0 fail。
- 两项 exact-patch 正控闭合本轮 major：①删除 catch 的 `onOutcome("failed")` 后 admission 11 pass／2 fail，恰为 throw-before-callback 与 late-callback 两用例，均收到 pending sentinel；②把默认 sink 改回 throw 后 registry 3 pass／1 fail，terminal 仍 fail-closed，但 `sinkEnqueueErrorsTotal` 由 0 变 1，证明测试能区分“端口遵约”与“controller 兜底”。两项均先 reverse-apply check 再恢复，恢复后 admission 13 pass／0 fail、registry 4 pass／0 fail。
- 结构怪味扫描发现 `runtime.ts` 重复声明 `enqueue()` 且弱于共享 sink 契约（`src/lib/history/worker/runtime.ts:41-44`，重复接口／契约漂移）；本轮让 `HistoryPersistenceRuntime extends HistoryTerminalSink` 并删除重复签名。扫描范围为本轮五个代码／测试文件、所有 `HistoryTerminalSink` 实现及计划中的 legacy adapter；未发现需暂缓的新结构项。修后 Worker 42 pass／0 fail，typecheck／lint／`diff --check` 绿。
- 本轮最终门禁：定向 regression 490 pass／0 fail（8 files，3.93s）；全 backend 的发现集合以 `tests/**/*.unit|it|http.test.ts` 为边界，Python `Path.rglob` 与 `fd|rg` 两种方法均得 694 files，16 shards 全部退出 0。最终代码态连续两次分别为 5751 pass／0 fail（26.84s）与 5856 pass／0 fail（27.05s）；runner 的 `tests` 字段按源码定义为当次 `pass+fail`、不含运行时 skip，故不把动态 tally 当冻结覆盖数。typecheck、目标 lint、`git diff --check` 绿。
- 同一 reviewer `acf499466aa10c311` 复审 `fb3a969d..9e5ab5a2` 后逐项判定 C1–C7 PASS，`blocker=0`、`major=0`、spec compliance PASS、code quality PASS，并在目标 worktree 独立运行 fast 得 5057 pass／0 fail。转录报告见 `docs/tmp/2026-08-08-history-worker-batch-1a-rereview.md`；Batch 1a 已完成，当前只待安全 fast-forward 合入 `master`。
- 本轮方案反思：①更好的项目内替代是把 no-throw 契约只维护在 `HistoryTerminalSink`，让 runtime 继承它，而非在两份接口各写一次；已实施。②判据判别力同时覆盖错误状态能否通过与正确状态能否通过：删除 controller settlement 后两条用例红，恢复后绿；默认 sink 改回 throw 后仅契约诊断红，证明没有把 controller 的防御兜底误当 sink 遵约。③未采用第三方方案：这里是项目内十余行同步状态转换和现有 Worker runtime 端口，不存在边界匹配、能减少自研状态或提升可靠性的成熟外部库；引入队列／重试库反而无法裁决 unknown acceptance，也会越过本 batch 契约。
- tsdown 0.22.3 的 array 多入口实测会保留源目录并破坏 `dist/main.mjs`；已按本地官方类型声明改用 object alias entry，固定两个 basename。
- Bun 1.3.14 的 `node:worker_threads` fixture 抛错时先发 `error`，随后 `exit` code 可为 0；oracle 锁定 error 内容与 `error→exit` 顺序，不硬编码非零码。
- 首次全 backend 连续三次稳定为 6994 pass／1 fail：`shutdown.unit` 的自然 drain 用 30ms completion 与 100ms deadline 真实 timer 竞速，高 shard 负载下误入 Phase 3；改用既有 `FakeClock` 后具名 25／25、shutdown 50／50、全 backend 6995／6995。
- 全 backend 随后咬出新 `setHistoryPersistenceRuntimeForTests` 未进入统一 `RESETTERS`；已登记到 injected seam 区，`resetters-complete` 和全 backend 均绿。
- Mutation 证据：①删除 generation stale gate 后 stale counter 0≠1；②真 Worker 骨架伪报 `persisted` 后 contract 收到 persisted≠failed；③删除 tsdown Worker alias 后独立临时 build 缺 `history-worker.mjs`。三项均用冻结 exact patch 注入，reverse-apply check 后恢复，恢复测试全绿。
- 结构扫描先补 envelope version／ready driver；初轮 reviewer 继续证实 start/hot config、status、drain、raw target、canonical record 仍可穿透。已用 malformed matrix 驱动完整 transport validators，合法 partial status 正控通过；不复制 opaque payload 业务 schema。
- Reviewer 证实同步 send/parser/no-transport 抛错会遗留 pending。已统一 outbound `send()` 为 parse→clone→transport 的 no-throw 状态转换；initialize send failure 使 start promise reject，畸形 enqueue 恰一次 failed 且 pending=0，shutdown 后 drain 立即 reject且不发送。
- Reviewer 证实默认 registry 在 Bun source-mode 错指不存在的 sibling `.mjs`。`resolveHistoryWorkerUrl()` 现按承载模块后缀选择 source `.ts` 或 bundled `.mjs`；无 override source registry 与临时 packaged bundle 均真启动通过。
- Reviewer 证实 callback 抛错会打断 settlement。正常 ACK 与 terminal bulk failure 现先原子移除 pending／写 tombstone／发布 status，再逐项隔离 callback；错误记入 `outcomeCallbackErrorsTotal`／`lastOutcomeCallbackError`，不覆盖原 Worker `lastError`，首 callback 异常不阻止后续项。

## 已作废的路子

- Batch 1a 不复用 `HistoryPersistenceRuntime.pendingEnvelopes` 作为 admission capacity：runtime pending 与 reservation 是不同生命周期，Batch 1b/2a 才在组合层核对 `unacked === pendingEnvelopes`。
- Batch 1a 不把 admission 接进 route 或 terminal bus；那会跨越 Batch 1b 的入口矩阵、shutdown 与 pending overlay 验收边界。
- 不使用 Bun global `Worker` 作为生产 transport；统一 `node:worker_threads`。
- 不让 Node 直接加载 TypeScript Worker；Node 验收走构建后的 `dist/history-worker.mjs`。
- 不让 `postMessage` 成功冒充 persistence ACK，也不在 Batch 0 硬编码 production success。
- Batch 0 不引入 admission、writer pool、无界队列或主线程 SQLite fallback。

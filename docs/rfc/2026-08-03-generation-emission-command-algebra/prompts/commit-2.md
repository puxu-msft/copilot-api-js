# Kick-off：Commit 2 —— Owner state、serializer 与 coordination primitives

<!-- prompt-task-ids: T2.1 T2.2 T2.3 T2.4 T2.5 T2.6 T2.7 T2.8 T2.9 -->

## 背景 + 为什么

Commit 2 在 test adapter 下建立 owner private state、authorization/observation 双层、serializer、heartbeat coordination、terminal/finalize state machine 与 raw emitter interface；仍不接 production roots。它的任务是让 C4 能一次发布，而不是提前 shadow-send。

## 必读

- `../design.md`：§2.4/§2.5、§3.3、§4.1～§4.6、§7.5、§10.1/§10.2 R-5。
- `../cutover-plan.md`：§0.4/§0.4d/§0.4e、Commit 2、§11 #5/#6。
- `../traceability.md`：R-5 与 T2.* 反向出处。
- progress 文件与 `README.md`。

## 前置/停点

- Commit 1 已收口，准备期不存在性/属性快照基线未漂。
- #5 在 C1/C2 的归属已裁且贯彻；#6 的职责边界已裁。未满足即不收口。
- 所有 mutation 按 plan §0.4e，在第二隔离树/`/tmp` 或 exact patch 运行，不在 entry `$TREE` 上改坏 runner/state。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `GenerationWireState` | `src/lib/pipeline/types.ts:496-502` | 旧裸 anchor state |
| owner generic `write` | `src/lib/pipeline/delivery/session.ts:127-137` | ledger/clocks vs authorization 对照 |
| owner anchor close | `src/lib/pipeline/delivery/session.ts:422-430` | 成功后清 state |
| heartbeat producers | `src/lib/pipeline/delivery/session.ts:175,184,209,219` | unpark/park 判据 |
| `OwnerFailureReason` | `src/lib/pipeline/types.ts:295` | lifecycle failure 分支 |
| `classifyOwnerFailure` | `src/lib/pipeline/delivery/owner-failure.ts:41` | #6 正交 axis |

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T2.1 T2.2 T2.3 T2.4 T2.5 T2.6 T2.7 T2.8 T2.9 -->

逐 task TDD 以 plan Commit 2 为唯一施工顺序：

- `T2.1` OpenAnchorLease private identity/immutability；caller 不传 lease token。
- `T2.2` authorization/observation 双层四 mutation。
- `T2.3` cardinality auxiliary pre-damaged state，**不冒充 C4 production witness**。
- `T2.4` serializer non-enqueue primitive；barrier + short deadline + queue probe，不用全局 timeout。
- `T2.5` batch coordination，caller 无 timer control。
- `T2.6` unpark 活性先于 parked 否定断言。
- `T2.7` terminal/finalize first-wins/once/非第二 emission 入口。
- `T2.8` raw emitter 只收 validated envelope。
- `T2.9` 属性快照相等。

## 验收 gate

R-5 的阶段归属以 `traceability.md` 和 §11 #5 已裁结果为准；R-11/O-6 与共同门指向 plan §0.3/§0.4b。Commit 2 invariant：无 production owner、无 shadow lease/mapping/ledger/timer/raw emitter、旧 population 与 C0 相等。

## 提交指引

精确 pathspec、Conventional Commit、无模型署名、绝不 push；mutation 证据与 progress 同本 phase commit 记录。

## 红线

见 `README.md`。不以 RLock 掩自锁；不把 ledger 当 authority；不在此接 route/driver；不自行决定 #5/#6。
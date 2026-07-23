---
name: methodology-append-log-tail-cursor-silent-loss-traps
description: 从 append-only 表 tail 建派生索引时，游标选型的两个静默永久丢失陷阱（同毫秒 tie-break、poison 行卡死），只有合并态审查+新鲜探针能戳破被「多轮审查+实测」背书的假绿
metadata: 
  node_type: memory
  type: project
  originSessionId: d1c28c09-073d-4420-9040-968dce59a539
  modified: 2026-07-22T06:32:07.094Z
---

在 copilot-api-js 把 History 全文搜索移出主进程时，sidecar 独立进程 readonly tail `history-v3.db` 的 `v3_operations`（append-once）建 Tantivy 索引。tail 游标的选型踩了**两个都静默、都永久丢数据、都被逐 Phase 单测全绿掩盖**的陷阱，最终**只有 whole-branch 合并态对抗审查 + 亲手新探针**才戳破。

**陷阱一：`(committed_at, operation_id)` keyset 的同毫秒 tie-break 永久丢行。** `committed_at` 只有 1ms 精度、背靠背提交共享同一毫秒；`operation_id` 是随机 UUID，与提交顺序无关。若某毫秒内先 tail 到字典序较大的 op（游标推进到 `(ms, "zzz")`），同毫秒内**后提交**的字典序较小 op（`"aaa"`）永远不满足 `WHERE (committed_at,operation_id) > (ms,"zzz")` → 永久静默丢，`processed` 计数看着正常、不抛错、`/api/status` 报健康。**根因**：元组序 ≠ 真实提交顺序（同毫秒内随机）。裸 rowid 怕 VACUUM 重排、纯元组怕同毫秒乱序——**都不是安全 tail 键**。修法（不动权威库 schema、保「主进程零负担」）：tail 分两趟——边界毫秒用 `committed_at = ? AND operation_id NOT IN <indexedAtBoundaryMs>` 重扫至扫空（可证终止：每轮把新 id 折进排除集、候选池严格收缩）+ 严格晚于边界毫秒走 `committed_at > ?` 单调过滤；排除集持久化进游标文件、毫秒推进即清空防无界。**姊妹坑**：分页时同毫秒行数 > pageSize 且落在 page 边界，单次调用只吃一页——要在页满且末行同毫秒时继续 drain 该毫秒扫空，才兑现「单次 tail 完全追平」契约。

**陷阱二：per-row hydrate 抛错卡死整轮 tail。** tail 循环里逐行 `hydrateManifest`（可能抛：format version 偏斜、missing CAS object、incomplete sequence——独立部署下 sidecar 版本落后主进程是设计内置窗口，非边缘）。异常冒出整轮 → 游标不推进 → 每秒重读同一 poison 行、其后所有健康记录永久搜不到。删游标文件也没用（坏的是表里那行）。修法：per-row try/catch 隔离，**抛错也推进游标**、计入 poison 计数+去重日志。本项目 `telemetry/store.ts::computeTierSketchBlob` 早有同构「逐条捕获+丢弃 poison、不阻塞后续」纪律（见 skill `persistence-async-invariants`），未沿用是回归。

**元教训（承重）**：keyset 设计被「两轮对抗审查 + 实测 VACUUM 回归」背书过，但那些审查覆盖的是 VACUUM 场景、**没覆盖同毫秒 tie-break**——测试覆盖了作者想到的场景、没覆盖没想到的。逐 Phase 审查看不到（每片单测都绿），**只有合并态整体审查派新鲜异模型 reviewer 亲手造新场景探针**才逮到。「通过/绿/被权威背书」不自证 → [[feedback-pass-null-clean-not-self-validating]]；集成缝只在合并态现 → [[methodology-cross-phase-integration-seam-only-caught-at-merged-state]] / [[methodology-merged-state-review-catches-env-branch-seam]]。可观测性同等重要：sidecar UDS 可达 ≠ tail 在进展（ping 命中 native 短路分支、对 tail 卡死零感知）——status 要报 daemon 自报的「最近成功 tail 时刻 / poison 计数」而非仅 socket 可达。

**Why:** 这两个陷阱是任何「从单调 append 日志 tail 建派生物」的通用形状（backfill、CDC、索引、物化视图），且都静默永久丢数据、都逃过同源单测。
**How to apply:** 设计 tail 游标先问「排序键在同刻/同值下是否唯一且等于产生顺序」「单行处理失败是否卡死整轮」；派生索引落地前必做合并态审查 + 让异模型 reviewer 亲手造边界探针（同毫秒多条、poison 行、跨重启、跨 page），别信「多轮审查+实测过了」。tail 键的既有正例见 [[methodology-recoverable-backfill-cooperative-stop-and-keyset]]（那里 `(started_at,id)` 的 id 是单调的、无本陷阱）。

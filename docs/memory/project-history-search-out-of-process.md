---
name: project-history-search-out-of-process
description: History 全文搜索移出主进程为独立常驻 systemd sidecar 服务（Phase 0-4 + 2 blocker 修复，landed 分支待合并 master）
metadata: 
  node_type: memory
  type: project
  originSessionId: d1c28c09-073d-4420-9040-968dce59a539
  modified: 2026-07-22T12:24:06.265Z
---

History 全文搜索（Rust/Tantivy）从主 Bun 进程移到**独立常驻服务进程**（`history-search-daemon`，systemd 管生命周期，主进程**不 spawn/监管**），彻底崩溃隔离（native abort 拖不垮主进程）。链路：sidecar readonly tail `history-v3.db`（`(committed_at,operation_id)` keyset + 同毫秒重叠去重）→ manifest 重建 record → `projectSearchableText`（只索引对话+响应）→ Tantivy 索引 → UDS（长度前缀 JSON）；主进程持 UDS client、`GET /history/api/search?source=inbound` 转发、不可用降级返空 partial。

**权威 SSOT**：[docs/DESIGN.md](../../docs/DESIGN.md)「活的架构现状」History V3 行（全貌 + 2026-07-21 架构修订原因 + 两 blocker 修复）、[docs/API.md](../../docs/API.md)（`/history/api/search`、`/api/status.history_search`）、[docs/plan/2026-07-21-history-search-out-of-process.md](../../docs/plan/2026-07-21-history-search-out-of-process.md)、[contrib/systemd/history-search.service](../../contrib/systemd/history-search.service)。

**承重经过（别在此重述细节，看正式归属）**：① 起因是 in-process Tantivy 每请求一 segment→232GB→内存崩溃，先 in-process 批量提交止血（`d5e2309d` on master，**用户可安全重启的就是这个**），再演进进程隔离；② 首版「主进程 spawn+监管」被对抗审查实测推翻（orphan 持锁 + blue-green 竞争 LockBusy）→ 用户改独立常驻服务；③ 合并态审查戳破 keyset 假绿（两静默数据丢失 blocker），教训见 [[methodology-append-log-tail-cursor-silent-loss-traps]]。分支 `feat/history-search-out-of-process`（`.worktrees/history-search-oop`）31 commit，待合并 master。**分支上有 4 个基线既有测试失败**（store-performance/store.it，非本分支引入）。

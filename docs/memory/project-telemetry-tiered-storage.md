---
name: project-telemetry-tiered-storage
description: 遥测分层持久化大特性(独立 telemetry.db + DDSketch + 全可配)——P0-P7 全 landed+reviewed、已 rebase+merge 入 master、承重教训与两决策
metadata: 
  node_type: memory
  type: project
  originSessionId: 7654802f-e457-41c1-918b-47b2995359ac
---

遥测从单 27MB JSON 迁到独立 `telemetry.db`(SQLite 三层 rollup raw5min/hourly/daily + 终身 cumulative + DDSketch 分布 + 全可配 `telemetry.*`)。纯聚合层、行级明细委托 History DB。

**进度(2026-07-14，已收尾)**:**P0-P7 全 landed + 全 per-task review Approved + 全分支合并态评审通过(fix 后) + 已 rebase 到 master + 已 merge 入 master**（分支 tip `39bbd8ee`，现为 master 祖先；rebase 消 5 条 stale-base 失败 payload-rewrite×4+negotiation×1——分支基 06c56644 早于 master oracle 刷新、telemetry 零触碰那些文件；rebase 时 `docs/todo/deferred-backlog.md` 唯一冲突按行级共存取并集解决）。隔离 worktree `.worktrees/telemetry-storage/` 可清理（merged）。全 telemetry 套件 130+ tests 绿、ui-v4 typecheck+build 双绿。

**权威**:spec `docs/spec/2026-07-13-telemetry-tiered-storage.md`、plan `docs/plan/telemetry-tiered-storage/`(P5-P7 已按用户决策重构)、DESIGN.md「活的架构现状」telemetry.db 行 + 核心模块 request-telemetry 行(已同步) + skill `telemetry-architecture`/`history-backfill`/`persistence-async-invariants`。

**两个用户决策(重构了 phase 形状)**:
1. **读源方案 2「dimBuckets 存活作 live cache」**:现有端点读**内存**(byte-compat 平凡、零改动),纯读 SQLite 因 dual-write ≤60s outbox 滞后违 byte-compat 已排除。故 P5 变**纯附加**(只加 /api/stats 新 window lifetime/30d/90d + sketch 分位)、现有端点不碰。
2. **P7 单轨 + 不保护旧 UI**:翻转 dimBuckets 重建源 JSON→SQLite + 删 JSON 写(单轨)。`/api/stats?7d` histograms 是 **old `ui/` 专用**(当前 ui-v4 不用,`ui/src/api/http.ts`)→退役出空 stub;**sinceStart 腿 histograms 保留**(喂 /metrics Prometheus,进程内活功能)。

**承重红线**:cost **scaled-int micro**(`round(cost*1e6)` per-request round-then-sum、绝不 REAL/nano-撞2^53);**SQLite 只存 DDSketch 无固定桶列**(HIGH-1,固定桶只活 /metrics 内存);DDSketch **手动 DenseStore 序列化**保 min/max 绝不 protobuf;**γ 建库冻结** tel_meta['sketch_gamma'](非 live config——防热重载 γ 使 permanent blob 永久 wedge,MAJOR-2);双轨计数(进程内归零 + 持久 cumulative);cardinality_cap 可配(`state.telemetryCardinalityCap`);cumulative 腿 cap **DB-seeded** 抗重启(live + backfill 一致)。

**本轮踩的坑/教训(高价值)**:
1. **对抗审查逼出两个静默持久化缺陷**(我自己的 opus reviewer 漏了 MAJOR-2、implementer 自派的异视角 reviewer 抓到):MAJOR-1=db-open 失败喂养门只判 enabled 不判 db!=null → outbox 无界 OOM;MAJOR-2=运行时改 sketch_gamma → drain 单事务 all-or-nothing + 无限 foldback 放大成永久 wedge 静默丢全部写入。根因修=γ 绑 db + drain 两阶段 poison 隔离(事务外 compute + 事务内纯写)。→ **跨视角对抗审查 + 异模型 reviewer 无可替代**。
2. **合并态评审抓 per-task 看不到的集成缝**:backfill cumulative 腿不 cap(而 live cap)→ seed 继承 over-cap 集 → post-migration 重启 live 停跟踪新 key(活路径降级);cardinality_cap 死钮(定义零消费者、违目标1全可配);DESIGN/API/spec T7.4 doc-sync 整个漏做(DESIGN.md 主动误导)。→ **per-item reviewed ≠ merged-state reviewed**。
3. **disjointness 时序→结构**:backfill 重读可变 JSON 文件有双计窗口(post-listen persist 折回) → 改消费 init 冻结快照(结构保证)。
4. **stale-base 分叉分类**:全套件红先 `git log 06c56644..HEAD -- <失败域文件>` 证零触碰 → 继承自陈旧分支基、rebase 自愈,非本特性缺陷。别当污染修。
5. **cwd 漂移**:worktree 命令 cwd 会漂回主仓 master,每个 git/bun 命令须显式 cd 到 worktree(一次虚惊以为 P2 接线丢失)。
6. **迁移 transient + footgun**:首启 dimBuckets 从空 tel_raw 重建早于 backfill → legacy 下次重启才现(裁 acceptable、backlog);naive backfill→rebuild 有坑(rebuild `dim.set` 覆盖非 merge 丢未 drain 增量,须先 flush)。

**Related**: [[reference-undici-websocket-runtime-split-bun-vs-node]]、[[feedback-config-philosophy-separate-compat-and-warn-continue]]、[[feedback-verify-ui-with-build-not-just-typecheck]](P7 ui-v4 双绿)、[[feedback-pass-null-clean-not-self-validating]](全程 exact-quantile 独立 oracle)、[[methodology-full-suite-red-classify-before-pollution-playbook]](stale-base 分类)。

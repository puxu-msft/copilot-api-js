# Kickoff — Telemetry Tiered-Storage 实施

**你要做的事：** 按 [../plan.md](../plan.md) 分阶段实现「遥测分层持久化」——把遥测从单 27MB JSON 迁到独立 `telemetry.db`（SQLite 分层 rollup + DDSketch 分布 + 全可配 `telemetry.*`），保持 `/metrics` 与 `/api/status.requestTelemetry` 客户端契约逐字节不变。

**先读（按序）：**
1. `docs/plan/telemetry-tiered-storage/plan.md` — 本实施计划（Global Constraints + Phase DAG + 每 task 文件/接口/oracle/不变量）。
2. `docs/spec/2026-07-13-telemetry-tiered-storage.md` — spec（承重不变量 1-8、双存储、双轨、迁移全量吸收）。
3. `exp/telemetry-storage/CONCLUSIONS.md` + `probe.mjs`/`sqlite-probe.mjs` — PoC 已验证的序列化/DB 行为（照抄已证形状，别重新发明）。
4. skills：`telemetry-architecture`（registry 三支柱 + cap per-store + histogram _sum/_count 同批坑）、`history-sqlite-schema`（Umzug hybrid + STRICT/WITHOUT ROWID + zstd）、`history-backfill`（可恢复骨架）、`test-isolation`（DI 临时 db_path）、`bun-node-runtime-gotchas`。

**红线（Global Constraints，每 task 隐含继承）：**
- cost 用 **scaled-int micro**（`round(cost*1e6)`、列名 `cost_*_micro`、INTEGER），绝不 STRICT INTEGER 存 REAL（PoC 证抛异常）。**micro 非 nano**：nano 使永久 cumulative 撞 2^53 丢精度、且 token 是整数使 micro 下限已够。
- DDSketch **手动 DenseStore 序列化**（保 min/max），绝不 `toProto/fromProto`；`sketch_gamma` 下限 ~0.005。
- `/metrics` 读**精确固定桶**（非 sketch），`_sum`/`_count` 同批；DDSketch 仅供 `/api/stats`。
- **双轨计数**：进程内 process-lifetime（/metrics + thinking_blocks 归零契约）+ 持久 cumulative（lifetime）。
- config **5 触点**（schema+config apply+state+bundled yaml+运行时选项表），warn-continue。
- registry（维度/度量/分布**定义**）零改动，只替换存储读写层。
- **隔离 worktree** `.worktrees/telemetry-storage/` + 分支（P3 起，并发会话隔离）；细粒度显式 pathspec commit；**绝不杀 4141 主服务器**（测试用非 4141 端口）。

**执行纪律：**
- **TDD**：每 task 先写失败测试（含 exact-quantile 独立 oracle，非 sketch-vs-sketch / 非自证）→ 证失败 → 最小实现 → 证通过 → commit。
- **逐字节兼容**用 golden oracle（P5 的 `/metrics`、`/api/status.requestTelemetry`）：改动前先锁旧输出快照。
- **每 phase 终态** typecheck 绿 + 该 phase 测试绿 + 无半坏中间态；ui-v4 相关（P7）必跑 `typecheck:ui-v4` + `build:ui-v4`（根 typecheck 不覆盖子项目、`~backend` 须纯）。
- 遇 spec/plan 与代码矛盾：先用代码 + 不变量自解（scope-ambiguity-then-ask），真分叉才停问。
- **收尾**：subagent 合并态审查 → DESIGN.md 同步（活的架构现状 + 类型架构 + config 5 触点清单加 telemetry 行）→ 记忆库维护 → 归档 plan 状态注解。

**起点：** Phase 0（DDSketch 封装，纯函数，PoC 已证形状）——附全套 bite-sized TDD 步骤，照做即可。

**Phase 内 task 展开：** plan 给了每 task 的文件/接口/oracle/不变量；逐字节 bite-sized 步骤在执行时即时展开（subagent-driven-development 的工作方式）。

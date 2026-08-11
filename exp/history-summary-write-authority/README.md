# History summary write authority PoC

## 问题

Task 9 的 ready-summary authority 设计需要一种 connection-local controlled maintenance mode，供 persistent SQLite trigger 同步读取。本 PoC 最终要裁决当前 Bun/Node 双 runtime 栈能否提供该原语；当前已完成步骤 A 的公开 API 盘点、步骤 B1 的 native extension capability 与步骤 B2 的 controlled maintenance scope 状态机。

## 本步方法

- 在固定 Bun 1.3.14 中列出 `bun:sqlite.Database` 的 static、prototype 与 instance own properties，并用 `:memory:` 数据库实跑 DDL、prepared statement、`serialize`、static `Database.deserialize`。
- 在真实 Node v24.16.0 进程中直接加载 `node:sqlite.DatabaseSync`，列出 API，并用 `:memory:` 数据库实跑 DDL、scalar UDF、aggregate UDF、authorizer、serialize/deserialize。没有从 Node import Bun-only 模块。
- 在真实 Node 进程 import 项目 `packages/foundation/src/sqlite/driver.ts`，实跑 `createDatabase(":memory:")`、DDL、insert/select。
- 对照安装的 `@types/bun` 1.3.14 所解析到的 `bun-types/sqlite.d.ts`，以及 `@types/node` 24.6.2 的 `sqlite.d.ts`。后者早于当前 Node v24.16.0 runtime 表面，因此类型缺项与 runtime 实测分开记录。

完整机器可读结果见 `runtime-api.json`；生成它的原始 runtime 输出是 `bun-runtime.json` 与 `node-runtime.json`。

## 本步结论

1. Bun 1.3.14 的公开 `Database` API 存在 `loadExtension`、`serialize`、`transaction`，并以 static `Database.deserialize` 提供反序列化；不存在公开的 `function`/`scalar`、`aggregate`、`setAuthorizer`/`authorizer`、update hook 或 preupdate hook。runtime prototype 与安装的 1.3.14 类型声明一致。
2. Node v24.16.0 的 `node:sqlite.DatabaseSync` 公开并实测可用 `function`、`aggregate`、`setAuthorizer`、`loadExtension`、`serialize`、instance `deserialize`；不存在 callback-style `transaction` helper，也未发现 update hook 或 preupdate hook。安装的 `@types/node` 24.6.2 尚未声明 runtime 已存在的 `setAuthorizer`、`serialize`、`deserialize`，说明这里不能只凭项目类型版本判断 Node runtime 能力。
3. 当前项目不依赖第三方 SQLite driver。`packages/foundation/src/sqlite/driver.ts` 在 Bun 选择 `bun:sqlite.Database`，在 Node 选择 `node:sqlite.DatabaseSync`；统一面仅暴露 database 的 `exec`、`prepare`、`close`、`transaction`，statement 的 `all`、`get`、`run`，以及 `readonly` open option。
4. 因此，即使 Node backend 已具备 connection-local scalar UDF 与 authorizer 的公开 API，统一 driver 尚未暴露它们；更关键的是 Bun 1.3.14 公共 API 没有对应注册能力，当前双 runtime 公共交集不能直接实现设计中的 connection-local UDF。

## B1 native extension capability

本机具备 `cc 13.3.0`，并在既有 Miniconda 安装中找到 `/home/xp/miniconda3/include/sqlite3ext.h`；未下载或安装任何内容。`maintenance_mode_extension.c` 构建为本地 `.so`，加载时给每个 SQLite connection 注册只读 `maintenance_mode()` 与 connection id getter；另导出供 host FFI 调用的 `maintenance_mode_set(connection_id, enabled)`，没有 SQL setter。这里的“host-only”精确含义仅是 SQL 不能设置 mode；能在同进程 `dlopen` 该 extension 并调用导出符号的代码仍能切换 mode，属于本 PoC 威胁模型外。

实测结果：

- Bun 1.3.14 通过公开 `Database.loadExtension()` 加载 extension，并通过公开 `bun:ffi.dlopen()` 调 host-only toggle。Persistent trigger 同步读取 getter；普通 SQL 传参调用 getter 失败、mode 关闭时写入失败、host scope 内写入成功、第二 connection 保持关闭、清零后再写失败。
- Node v24.16.0 以 `DatabaseSync.function()` + per-connection JS closure 实现等价 getter；相同 trigger 与 connection 隔离矩阵通过。
- Bun 的 `Database.handle` 只是 Bun 内部 handle index，不是可传给系统 `libsqlite3` 的 `sqlite3*`；`fileControl()` 也没有 extension-defined connection toggle 接缝。本实验实际可行的 Bun host 接缝是 extension 导出符号 + `bun:ffi`，意味着正式方案需要构建并交付 native extension，且统一 driver 需新增受控 scope API。

机器可读输出：`b1-bun.json`、`b1-node.json`。

## B2 controlled maintenance scope 状态机

Bun extension + FFI 与 Node closure UDF 使用同一语义 host helper。策略选择为所有 nested scope 均 fail closed，包括 same-mode 与 different-mode；理由是它避免内层提前清零或引用计数错误，并让 callback 的同步临界区只有一个明确 owner。Entry 时要求 mode 为 off。

双 runtime 实测矩阵均通过：正常 scope 内 trigger 写成功；Promise 与任意 thenable 返回在 callback 已执行后报错；callback throw、transaction body throw、commit throw、rollback throw、cleanup throw 后 mode 都是 off；每个 case 后普通 SQL 写入仍被 trigger 拒绝，第二 connection 始终 off。错误优先级固定为：callback/begin/commit 原错误优先于 rollback/cleanup 错误；没有原错误时 cleanup 错误传播。“sync-only”精确指返回值契约，不承诺 callback body 未执行：Promise executor 在构造时同步运行，then getter 在检测时同步运行。事务外两类 callback 均先成功 INSERT，随后 helper 才抛 TypeError，副作用已持久化；同样 callback 放进 BEGIN/ROLLBACK hooks 后，TypeError 触发 rollback，写入不存在。这证明正式 API 的原子性边界必须包含 SQLite transaction，不能只靠返回值检查。

Node 的 trigger 通过注册的 UDF 真实回调 host helper，reentrant scope 被 nested gate 拒绝。Bun extension 没有 native→JS host callback channel，因此没有伪造 trigger reentrancy；该 case 明确标为 not applicable。`B2_MUTATE_CLEANUP=1` 会跳过清零，Bun 与 Node 都在首个 case 以 `case failed: normalScope` 退出，证明 post-case oracle 能识别残留 mode；恢复默认后全绿。

结果：`b2-bun.json`、`b2-node.json`。最终独立 review 裁决不追踪实验 `.so`：仓库保留 C 源码、构建配方与 probes，运行 B1/B2 前在本机重建。已验证的 Linux x86-64 ELF SHA256 为 `a15766a2dc7cc5e9ce2912f1fa5eb2890203de3b616cfb624cf468eac2f91f9f`；该 hash 只标识本机实测 artifact，不代表跨平台分发件。

## B3 correctness checkpoint：normalized refs + integrity epochs

`probe-b3-correctness.ts` 建立纯 SQLite 最小 schema：canonical `operations`、`evidence`、ordered `operation_refs`、`operation_integrity`、窄 `summaries` 与全局 `ready_marker`。Canonical manifest/evidence 变化的 trigger 同步递增 epoch、把 integrity 置 invalid、summary 置 pending、marker 置 0；ready query 对窄 summary 做 format/epoch/digest 检查及 refs→evidence epoch anti-join，不读取 manifest payload。

数据生成矩阵已实跑：每档 512 summaries、每 row 256 KiB manifest；refs=0/4/32 分别生成 0/2,048/16,384 normalized refs。兼容与正确性矩阵全部符合预期：v1、v2、valid-v3 为 ready；future manifest、digest mismatch、write-after-attestation 均同步变为 not-ready。

但“错误状态仍全绿”反例成功：普通 SQL 先修改 canonical payload+digest，再把 `operation_integrity` 的 epoch/digest/status、summary status 与 ready marker 一并重写为自洽值，ready query 返回该错误状态。结论是纯 epochs/normalized refs 能检测未协调变化，却不能让 validation state 对普通 writer 具有独立 authority；若 Task 9 的范围要求普通 SQL 不能重新认证当前 bytes，B3 存在物理 blocker，仍需要 B1/B2 形式的受控 writer boundary，或读时重算不受同一 writer控制的外部证明。

本 checkpoint 结果在 `b3-correctness.json`，内含完整 DDL、ready SQL、生成计数、正确性矩阵与反例最终状态。正控 `B3_MUTATE_DISABLE_INVALIDATION=1` 移除 operation invalidation trigger 后，write-after-attestation 从预期 not-ready 变成 ready，进程非零退出；恢复默认后矩阵全绿。

## B3 performance checkpoint：EXPLAIN 与本机观测

`probe-b3-performance.ts` 对 512 summaries、refs=0/4/32、payload=64 B/256 KiB 的 get/list/session/stats 各跑相同 schema/index 下的 baseline 窄表与 integrity query。每格 3 轮 warmup、15 轮随机 A/B 顺序 paired samples；原始样本分别保存在 6 个 `b3-perf-refs*-{small,large}.json`，汇总在 `b3-performance-summary.json`。环境为 Bun 1.3.14、Linux WSL2 x64、AMD EPYC 7763、16 logical CPUs，基线 commit `bc5f6065c106c8e8740a2f78caa5deccbcf4725c`。

所有 integrity plan 均通过 covering index 读取 operation format/epoch/digest 与 evidence epoch，`EXPLAIN` 未命名 `manifest_payload`，query projection 也不含该列；get/list/session/stats 均出现 `CORRELATED SCALAR SUBQUERY`，按候选 summary row 用 operation refs 主键索引扫描 refs，再用 evidence covering index lookup。无一 plan 使用 temp B-tree。由此可把 B3 定位为“不 materialize manifest blob 的窄读机制”，但 refs anti-join 明确是 per-row 成本。

256 KiB 档的 median（baseline→integrity，paired delta，单位 µs/execution）：refs=0 时 get `3.70→6.33 (+2.57)`、list `61.52→120.32 (+66.18)`、session `9.79→55.29 (+46.05)`、stats `115.53→685.36 (+569.83)`；refs=4 时 `5.54→17.62 (+9.37)`、`64.90→310.34 (+235.43)`、`8.03→143.59 (+133.70)`、`146.65→2666.77 (+2483.39)`；refs=32 时 `3.34→26.61 (+22.83)`、`68.19→1381.26 (+1318.50)`、`11.06→788.39 (+778.09)`、`124.69→11486.18 (+11344.05)`。这些是本机内存 PoC 观测，不设通过阈值、不声称零回归。

64 B 与 256 KiB 两档的 plan 形状一致，且 payload 增大没有跨 refs/query 一致的 wall-time 增长方向；结合 operation covering index 与不投影 blob，可确认本探针 query 没有意外 materialize payload。它不证明生产文件数据库、冷 cache 或未来 query 仍 size-independent。

与 B1/B2 的已证事实比较：B3 无 native build/load 依赖、同一 SQL 形状可由 Bun/Node driver 执行，但正确性 checkpoint 已证明它只能检测未协调变化，普通 SQL 可同步重写 validation state；B1/B2 则实测提供 connection-local host authority，但 Bun 需要 C extension + FFI，且存在 native artifact 交付负担。这里只记录实测取舍，不作最终方案选择。

结构怪味：`probe-b3-performance.ts` 将四类 integrity SQL 重复展开，属于实验代码重复；本轮保留，因为逐条 SQL 是 EXPLAIN 证据本体，抽象生成器会弱化可审计性。正式实现不得复制四份，应共享 integrity predicate/validated snapshot primitive。

## 它没有证明什么

- 步骤 A 的“公开 prototype 与类型声明均无该方法”不证明 unsupported native internals 绝对不可达；B1 只证明了本机 extension + host FFI 这一条额外路径。
- B1 证明本机 Linux x86-64 环境可构建并加载 extension，不证明 macOS/Windows、其他 libc/CPU、无 compiler/header 的安装环境可用；实验 `.so` 因此不纳入 Git，必须按配方在目标环境重建。
- B1 没有证明 native artifact 能满足项目“默认不构建、无 Rust toolchain 也可安装”的现有约束；正式采用它会新增 C toolchain 或预构建 artifact 的交付决策，且不能把 README 中的本机 SHA256 当成可分发 artifact 承诺。
- Bun trigger reentrant native→JS host callback 未验证，因为当前 extension 没有该 callback channel；Node 对应路径已真实执行。
- commit/rollback throw 是 helper hook 在 SQLite `COMMIT`/`ROLLBACK` 后抛出的确定性模拟；没有注入 SQLite engine 自身的 I/O/locking failure。
- Promise executor 与 then getter 的同步副作用在返回值检查前已执行；helper 只能拒绝 thenable 返回值并清 mode，无法撤销事务外副作用。正式 API 必须在同一 helper 内强制包裹 SQLite transaction，并在 TypeError 路径 rollback；TypeScript 同步 callback 类型只能辅助，不能代替 runtime thenability 检查与 transaction。
- B3 performance 是单机 in-memory 粗测，不是正式 benchmark；未覆盖文件 I/O、WAL、并发 writer、cold cache、进程 RSS 或生产数据分布。
- Payload size 对照依赖 query projection + covering-index EXPLAIN 与多轮 timing 的一致证据，不是 SQLite page-read 级 tracing；未直接记录 `sqlite3_stmt_status`/page cache counters。
- B3 correctness 只覆盖 operation payload update、format/digest mismatch 与普通 SQL 重写 derived state；尚未覆盖 evidence/ref 的完整 INSERT/REPLACE/UPDATE/DELETE、FK-off、PK rename 矩阵。
- 256 KiB payload 使用未压缩内存 BLOB，目的是证明 query 形状可避免读取该列，不模拟生产 compression/decode 成本。
- 本步没有比较或选择正式实现方案，也没有修改产品代码。

## 复跑命令

在仓库 worktree 根目录运行：

```bash
bun exp/history-summary-write-authority/probe-bun.ts
node exp/history-summary-write-authority/probe-node.mjs
node exp/history-summary-write-authority/probe-driver-node.mjs
python3 exp/history-summary-write-authority/assemble-runtime-api.py
cc -shared -fPIC -O2 -I/home/xp/miniconda3/include -o exp/history-summary-write-authority/maintenance_mode_extension.local exp/history-summary-write-authority/maintenance_mode_extension.c
bun exp/history-summary-write-authority/probe-b1-bun.ts
node exp/history-summary-write-authority/probe-b1-node.mjs
bun exp/history-summary-write-authority/probe-b2-bun.ts
node exp/history-summary-write-authority/probe-b2-node.mjs
B2_MUTATE_CLEANUP=1 bun exp/history-summary-write-authority/probe-b2-bun.ts # expected nonzero
B2_MUTATE_CLEANUP=1 node exp/history-summary-write-authority/probe-b2-node.mjs # expected nonzero
B2_MUTATE_SIDE_EFFECT_ORACLE=1 bun exp/history-summary-write-authority/probe-b2-bun.ts # expected nonzero at transaction rollback control
B2_MUTATE_SIDE_EFFECT_ORACLE=1 node exp/history-summary-write-authority/probe-b2-node.mjs # expected nonzero at transaction rollback control
sha256sum exp/history-summary-write-authority/maintenance_mode_extension.local
bun exp/history-summary-write-authority/probe-b3-correctness.ts > exp/history-summary-write-authority/b3-correctness.json
B3_MUTATE_DISABLE_INVALIDATION=1 bun exp/history-summary-write-authority/probe-b3-correctness.ts # expected nonzero
for refs in 0 4 32; do
  bun exp/history-summary-write-authority/probe-b3-performance.ts "$refs" 64 > "exp/history-summary-write-authority/b3-perf-refs${refs}-small.json"
  bun exp/history-summary-write-authority/probe-b3-performance.ts "$refs" 262144 > "exp/history-summary-write-authority/b3-perf-refs${refs}-large.json"
done
python3 exp/history-summary-write-authority/summarize-b3-performance.py
```

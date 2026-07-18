# History V3 验收报告 — 2026-07-16（2026-07-18 复核更正）

> **更正声明**：2026-07-16 的原报告已被本次复核取代。原报告把 terminal bus 动态订阅误称为 raw generation 热重载，并引用了不等价的 V2 容量基线，因此“10 项全部通过”“24.86×／44.98×”不能作为验收证据。

## 结论

**状态：有条件通过。** 隔离、canonical 记录、CAS/journal、全 operation kind、V3 产品读面和 raw generation rotation 均有实现与测试。format-v2 修复后，等价压缩基线下容量门槛重新达到 ≥10×。仍需诚实保留两项限制：

1. 已存在的 format-v1 行不会被在线迁移或自动压缩；新格式只影响新写入。未来离线 archiver 才负责旧 artifact。
2. writer 的 prepare/hash/compress 仍在主 JS 线程同步执行；Promise microtask 不是 CPU 隔离。本轮没有声称解决大型 operation 的 event-loop stall。

## 复核发现与处置

### 1. 旧容量结论无效

原测试把压缩后的 V3 与“部分压缩 head + 未压缩 stage JSON”的 V2 estimate 比较，不是等价物理基线。按 V2 实际压缩编码重算时，修复前 V3 page/live 比率仅约 **0.69×／1.26×**，未达到 10×。

处置：format-v2 将重复大值从 manifest/metadata/tracks/search projection 中移除，引入序列前缀 DAG，并修正性能测试。复核结果见同目录的 [performance verification](2026-07-16-history-v3-performance.md)。

### 2. 生产样本暴露 format-v1 放大

只读检查现有 `history-v3.db`：约 **3.996 GB／2,113 operations**。其中 compressed manifests 约 1.034 GB、objects 约 1.385 GB、tracks 约 145 MB、search objects 约 1.359 GB；最大单个 compressed manifest 约 6.53 MB（解压约 18.35 MB）。同一大请求通过 metadata/tracks/search 被重复保存。

处置：format-v2 manifest 只保留结构、handle→CAS 映射、sequence roots/overlays；完整 tracks 压缩到 `track_gz`。随后 schema v5 完全删除 `v3_search_*`，新 terminal 派生进独立 Tantivy v1 sidecar。**审计过程没有修改生产数据库；代码只在未来正常启动 reconcile 时执行迁移。**

### 3. Raw 热重载证据更正

`tests/history/v3/acceptance-verification.it.test.ts` 原“Terminal bus 热重载”只证明订阅者可动态加入，与 raw store generation 无关。

真实证据位于 `tests/history/raw/manager.it.test.ts`：

- path rotation 时在途 operation 保持冻结 generation；
- same-path reload 保留旧 lease 到 release；
- rotation 失败时保留当前 active generation。

验收测试现已改名为 terminal bus 动态订阅，不再冒充 raw 热重载。

### 4. 读取内存与派生数据

修复前 search 使用 `.all()` 载入全部 search rows 并逐个解压。当前实现已移除该读取与全部内嵌 search tables；兼容 API 返回空数据。列表/session/stats 优先读取 `summary_json`，旧 V3 行由有 poison backlog 的 summary backfill 补齐。详情仍按需 hydrate canonical record。

### 5. 测试隔离

`clearHistory()` 曾调用 V2 `clearAllEntries()`，在 V3-only 测试库产生 `no such table: entry_stages`。现改为事务清空 V3 data tables、保留 `v3_meta` schema metadata，并有逐表断言。

## 验收矩阵

| 判据 | 复核状态 | 主要证据 |
|---|---|---|
| 不读写／迁移 legacy `history.db`、archive、seal | 通过 | V3 owner guard、独立路径、read-consumer guard |
| 不调用内置 archiver | 通过 | V3 生产依赖边界与静态 guard |
| 全 model operation kind | 通过 | generation / count_tokens / embeddings / responses_ws round-trip |
| Canonical provenance 与双腿/双轨语义 | 通过 | recorder、arena source/derived、track round-trip tests |
| CAS + journal + writer | 通过（CPU 限制保留） | collision check、failpoint recovery、queue/drain tests |
| Raw generation 热重载 | 通过 | `tests/history/raw/manager.it.test.ts` |
| V3-only 产品读面 | 通过 | query/session/stats guard 与 API tests |
| 生产无 retention/自动删除 | 通过 | 无 reaper 接入；仅 test-only `clearHistory()` 可清空临时 V3 store |
| 等价压缩容量 ≥10× | 通过 | schema-v5 复核运行约 20.1× page delta、39.3× live blobs；测试硬门槛为 10× |
| 已有 format-v1 数据自动瘦身 | 不在范围 | 明确不在线迁移、不触碰 legacy artifact |

## 可复现测试

```bash
bun test tests/history/v3/acceptance-verification.it.test.ts
bun test tests/history/raw/manager.it.test.ts
bun test tests/history/v3/store.it.test.ts
bun test tests/history/v3/store-performance.it.test.ts
bun test tests/history/v3/read-consumer-guard.unit.test.ts
```

性能门槛只由 `store-performance.it.test.ts` 的等价压缩基线判定。验收 smoke suite 不再用“10 条写入 <500ms”替代 10× 容量证明。

## 兼容性说明

- format-v1 manifest/journal 保持可读；legacy v1 journal digest 有兼容校验。
- schema reconcile 只增列/增表和 backfill `summary_json`，不重写 canonical operation。
- format-v2 新写入使用新的 hash domain；不会把 v1/v2 不同 canonical 编码误认为同一对象。
- 旧 `history.db` 不迁移、不回填、不删除。

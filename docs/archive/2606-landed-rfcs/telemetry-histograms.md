> **✅ 已落地并归档** — 见同目录 [README.md](README.md)。本 RFC 顶部原状态行陈旧（写草案/待实现），其机制已完整实现于 `src/`，活的现状以 docs/DESIGN.md「活的架构现状」为准。

# RFC: Telemetry 分布直方图（latency 百分位 + token/queue 分布）

**Status:** 实现中（2026-06-23）。`operational-stats-and-lineage-removal.md` §7 把 histogram slot 列为暂缓；operator 指示「弱化 YAGNI、尽可能丰富」，故本 RFC 把它做满。
**Builds on:** [operational-stats-and-lineage-removal.md](../../rfc/operational-stats-and-lineage-removal.md)（dimension/measure registry 框架、开放 counters bag、通用 V3 持久、`/api/stats`、`/metrics`）。
**Driver:** sum-only counters 给不出分布形状——p50/p95/p99 latency、请求/响应体量分布、排队延迟分布都需要 histogram。registry 的开放 bag 已不 foreclose（§7 预留），本 RFC 沿同一框架把分布做成第一类公民。

---

## 1. 设计

### 1.1 直方图 registry（第三类注册项，与 dimension/measure 并列）

```ts
interface StatHistogram {
  name: string                              // duration_ms / queue_wait_ms / input_tokens / output_tokens
  boundaries: ReadonlyArray<number>         // 升序、log-spaced、固定（跨 bucket/维度可合并）
  extract: (opts, durationMs) => number | undefined  // 本次观测值；undefined=不观测；负值 clamp 到 0
}
```

四个 histogram（每个 `(dimension, key)` 各一份）：

| name | 观测量 | boundaries（log-spaced） |
|---|---|---|
| `duration_ms` | 请求总时延 `endedAt-startedAt` | 5,10,25,50,100,250,500,1k,2.5k,5k,10k,30k,60k,120k,300k |
| `queue_wait_ms` | 排队延迟 `entry.queueWaitMs` | 1,5,10,25,50,100,250,500,1k,5k,30k |
| `input_tokens` | `usage.input_tokens` | 100,500,1k,2.5k,5k,10k,25k,50k,100k,250k,500k,1M |
| `output_tokens` | `usage.output_tokens` | 50,100,250,500,1k,2.5k,5k,10k,25k,50k,100k |

加第五个分布 = registry push 一行（沿 measure/dimension 同款扩展性）。

### 1.2 存储：开放 bag 内的 `histograms`（零版本 bump）

`StatAccumulator` 加 `histograms: Record<string, { buckets: number[]; sum: number }>`——每 histogram 一份桶计数数组（长度 = `boundaries.length + 1`，末桶是 `+Inf` 溢出）+ **自track的观测 `sum`**。`createAccumulator` 把每个注册 histogram 初始化为全 0（结构性保证、无 `undefined`）。

**为何 histogram 自track sum 而非复用 counter**（对抗 audit H1 修正）：若 `_sum` 取配对 counter（如 `totalDurationMs`）、`count` 取桶数组之和，两者来自**不同的持久量**，在「7d 窗口横跨 pre-histogram 升级边界」时 desync——旧 bucket 只有 counter 无桶数组，聚合时 sum 含旧 bucket 贡献、count 不含，`average=sum/count` 被放大、Prometheus `_sum`/`_count` 契约破裂（实测 count=2/sum=100100/average=50050ms）。故每 histogram 自track观测 sum，使 count 与 sum 永远来自同一批观测、与全局 counter 解耦。

持久：per-key 值原本是扁平 `{ ...counters }`；histogram 存进**保留键 `__histograms`**（仅当有非零观测时写）：`{ ...counters, __histograms?: { duration_ms: [...], ... } }`。

- **V3 envelope 结构不变**（`version:3` 不 bump）——histogram 只是 per-key value 多了个 sibling 字段，符合 §3.5「维度/measure=数据，无版本 bump」的同一契约。
- **back-compat**：commits 7-8 写的旧 V3 文件无 `__histograms` → 加载后 histogram 从全 0 起，不丢 counters。
- **forward-compat**：旧 reader 的 `loadAccumulator` 只 copy number 字段、忽略 `__histograms`（对象）→ 不 crash、只丢分布（counters 无损 round-trip）。
- 桶 boundaries 跨版本变更时，loader 按**长度匹配**校验（`counts.length === boundaries.length+1` 才载入，否则丢弃该 histogram 从 0 起）——boundaries 是代码常量、极少改。

### 1.3 百分位（插值分位数）

`quantile(boundaries, counts, q)`：累计桶计数找到 q 分位落入的桶，在桶的 `[lower, upper)` 线性插值（Prometheus `histogram_quantile` 同款）。溢出桶（无上界）返回末 boundary。`count = Σ counts`（每请求对每 histogram 恰增一桶**当该量被观测时**——token/queue 缺失即 `extract` 返 undefined → 不观测，故 token 直方图 `count` 可 < requestCount，这正常）、`sum = histogram 自track观测和`（与 count 同批观测、§1.2）、`avg = sum/count`。breakdown 暴露 `p50/p90/p95/p99 + count + sum + buckets`。**已知插值伪影**：全为 0 的观测（如从不排队的 queue_wait）p50 ≈ `boundaries[0]/2` 而非 0（Prometheus 同款，无 `le=0` 桶钉零）。

### 1.4 投影

- **`/api/stats`**：`DimensionKeySnapshot` 加 `histograms: Record<histName, { count, sum, p50, p90, p95, p99, boundaries, buckets }>`——前端可直接渲染百分位 + 桶形。
- **`/metrics`**：每 histogram 出**标准 Prometheus histogram**——`copilot_api_<hist>_bucket{dimension,key,le="<b>"}`（**累计**桶 + `le="+Inf"`）+ `_sum` + `_count`，`# TYPE histogram`。scraper 用 `histogram_quantile(0.95, ...)` 自算分位。数据源仍 `dimSinceStart`（counter 语义）。
- **UI**：dashboard breakdown 面板每 key 增 `p50/p95 latency` 行。

## 2. 不变量 / commit 序列

- H1 histogram 基建（registry + acc.histograms + 序列化 + queueWaitMs）——**model golden 仍逐字节**（histogram 不进 model snapshot 投影）+ 旧 V3 文件无损升级 + forward-compat round-trip。
- H2 percentile 计算 + breakdown 暴露。
- H3 `/api/stats` 携 histogram。
- H4 `/metrics` Prometheus histogram。
- H5 UI 百分位。
- H6 测试 + 文档 + 对抗 audit。

## 3. 取舍与已知成本

- **持久体量**：histogram 给每 `(timeBucket, dim, key)` 加 ~4 数组 × ~13 数 ≈ 50 数。实际稀疏（5min bucket 只含当窗有流量的 key）。telemetry 文件是明文 JSON（未压缩）——高流量下增长，但受 cap（201 key/维度）+ 7d prune 双重有界。若日后成问题，可（a）只给子集维度挂 histogram，或（b）给 telemetry 文件加 zlib（history 已有先例）。本次先做满、文档化此成本。
- **boundaries 固定**：log-spaced 固定边界使跨 bucket/维度桶**可加合并**（变动边界则不可合并）。代价是分辨率固定；够用于 p50/p95/p99 运维判断。
- **`_count == Σbuckets == +Inf 桶`（恒成立）**：`/metrics` 的 `_count` 直接取累计到 `+Inf` 的值，故与桶和恒等、与 `_sum` 同批观测一致。**注**：`_count` 可 < requestCount——token/queue 直方图只在该量被观测（`extract` 非 undefined）时增桶，纯文本对话无 usage → 不计入 token 直方图，这是正确语义而非 bug（曾在初稿误述为"缺失时观测 0"）。`_sum` 是 histogram 自track观测和（§1.2），与 `_count` 同批，故 `average = _sum/_count` 恒正确、抗升级边界。

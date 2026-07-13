# PoC 结论：遥测分层持久化存储层实测

- **日期**：2026-07-13
- **关联 spec**：[docs/spec/2026-07-13-telemetry-tiered-storage.md](../../docs/spec/2026-07-13-telemetry-tiered-storage.md)
- **目的**：plan 前验证 spec 4 个「需实测」假设 + 2 轮评审提出的边界，避免实现期返工。
- **复现**：`cd exp/telemetry-storage && bun probe.mjs && node probe.mjs && bun sqlite-probe.mjs && node sqlite-probe.mjs`
- **runtime**：Bun 1.3.14 / Node v24.16.0

## 结论速览（全绿，无 bun/node 分歧）

| # | 假设 | 结果 |
|---|---|---|
| 1 | DDSketch 零依赖 | ✅ `bun add` 装 **1 package**、`dependencies: {}` |
| 2 | 手动 DenseStore 序列化往返一致 | ✅ 往返 p99 **完全相等**、vs exact oracle relErr ≤1% |
| 3 | 手动序列化保 min/max（protobuf `fromProto` 会丢） | ✅ min/max 均保住 |
| 4 | 跨层 merge 零累积误差 | ✅ 12 桶 merge：count **精确**(4800)、p99 relErr 0.4% ≤1% |
| 5 | γ bin 塌缩阈值 | γ=0.01→**692** bin、0.005→1383、**0.001→6909 塌缩**(>2048) |
| 6 | STRICT INTEGER 拒 REAL | ✅ 两 runtime 均抛 `cannot store REAL value in INTEGER column` |
| 7 | scaled-int cost 可行 | ✅ `round(cost*1e6)` 存 INTEGER、整数 SUM 精确 |
| 8 | BLOB(Uint8Array) 往返 | ✅ 两 runtime 字节精确、返回 `Uint8Array` |
| 9 | 小 sketch blob zstd 收益 | ✅ 单分布 ~950-1200B → 压 ~330-350B、**~3x**（非边际） |

## 对 spec 的确认与修正

1. **BLOCKER-1 确证**：cost 用 INTEGER 列会**运行时抛异常**（非静默截断）——两 runtime 一致。spec 的 scaled-int 决策正确且必需。
   - **新增注意（plan 定缩放因子）**：`round(cost*1e6)` 精度地板 = 1e-6 单位/请求。若成本单位小、单请求成本 < 1e-6 会 round 到 0。**建议缩放因子取 1e9（nano）** 或按实际 multiplier 量级基准定，保证最小非零成本 > 1/scale。整数 SUM 本身精确，唯一损失是每请求一次 round。

2. **HIGH-3 确证**：**手动 DenseStore 序列化可行且优于 protobuf**——真零依赖（不拉 protobufjs）+ 保 min/max。序列化字段：`{gamma, offset, minKey, maxKey, bins[], zeroCount, count, min, max, sum}`。重建：`new DDSketch({relativeAccuracy})` 后覆写 `store.{offset,minKey,maxKey,bins,count}` + sketch `{zeroCount,count,min,max,sum}`。

3. **跨层 merge 正确性确证**：spec「零累积误差」成立——merge 后 count 精确、quantile vs **独立 exact oracle**（原始值数组精确百分位，非 sketch-vs-sketch）在 1% 界内。

4. **γ 下限成文**：默认 **γ=0.01（1%）安全**（692 bin）；**γ ≥ 0.005 安全**（1383 bin）；**γ < ~0.003 触发塌缩风险**（0.001→6909>2048）。config `sketch_gamma` 应加**下限校验 ~0.005**（或文档化「配更紧 γ 会塌缩、跨层分位不再严格等价」）。值域按 latency 1ms..1e6ms、token 1..1e6 估。

5. **zstd 修正 reviewer 担忧**：小 sketch blob zstd **有 ~3x 收益**（非「边际」）——DenseStore bins 是稀疏整数数组、可压。建议 raw/hourly/cumulative **均压**（收益实在）。仍以生产真实 blob 复测为准。

6. **无 bun/node runtime 分歧**：STRICT INTEGER 拒 REAL、BLOB 往返、sketch 序列化在两 runtime **行为一致**——本存储层无需 runtime-conditional 分支（对比 undici WS 那类分歧）。

## 未覆盖（留 plan / 实现期）

- 生产真实 blob 分布的 zstd 比（本 PoC 用随机均匀分布，真实延迟分布更集中、可能压得更好）。
- `tel_dim`/`tel_key` 字典表在高并发写下的锁行为（量级极小、预期无碍，实现期跑并发测确认）。
- Umzug hybrid forward-runner 复用于独立 `telemetry.db` 的跨-runtime e2e（走 skill `history-sqlite-schema` 既有模式）。

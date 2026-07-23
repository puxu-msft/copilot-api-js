# PoC P-A FINDINGS — @anthropic-ai/sdk accepts the stitched continuation stream

> plan-2b §7 承重门 P-A。运行：`bun run exp/continuation-stitch/poc.ts`（SDK 0.106.0）。日期 2026-07-23。

## 问题

continuation-executor 会产出**一条**客户端流,拼接两次上游 exchange:已交付块(此例 thinking@0 + text@1)→ **不发 message_stop** → 续写 exchange 的块(去重其 message_start、按已交付 wire 块数重编号)→ message_delta + message_stop。两个待证:
1. 真 `@anthropic-ai/sdk` 是否接受这条缝合流(单 message_start、连续 index、单 message_stop)?
2. **C3**:重编号 offset 该用「wire 已交付块数」还是「ledger 长度」?(含 thinking 时两者不同——thinking 上线占 wire index 但被 extractor 排除出 ledger。)

## 结果(实测)

| 变体 | offset | 结果 | 客户端 `.finalMessage()` |
|---|---|---|---|
| **GOOD** | 2 = wire 已交付块数 | **不 throw** | 3 块干净:`thinking`(带 signature)+ `text"Partial answer..."` + `text"Continued answer..."`;stop_reason=end_turn ✅ |
| **BROKEN** | 1 = ledger 长度(排除 thinking) | **不 throw,但静默损坏** | thinking + `text"Partial answer before the cut. Continued answer after stitching."`(**两块被合并**)+ `text""`(**多出空块**) ❌ |

## 裁决

- **P-A PASS**:缝合流的目标 wire 形状被真 SDK 接受、正确累积(含 thinking signature 保真)。executor 可照此形状产出。**单 message_start / 连续 index / 单 message_stop / message_delta 收尾**是被接受的契约。
- **C3 坐实为承重 bug**:offset 用 ledger 长度会**静默损坏**(合并块 + 幻块),不 throw → 运行时不可检测,比抛错更糟。**offset 必须 = wire 已交付块数**(driver 侧独立计数器,每成功 flush 一个 commit 边界块 +1,无论 extractor 是否保留;复用 `AnchorIndexAllocator`)。BROKEN 变体是正样本对照,证明该 bug 真实、修复必要。

## 对实现的约束(executor 必须满足)

1. 续写 exchange 的第二个 `message_start` 必须**丢弃**(客户端全程唯一一个)。
2. 续写块 `content_block_*` 的 index 整体 `+wireDeliveredCount`(非 ledger 长度)。
3. 已交付块**不发** `message_stop`,只有续写最终成功那次发。
4. thinking 块进 wire 计数(占 index)、但不进 ledger(合成 assistant 前缀排除)——两个计数域必须分开维护。

## SDK 行为附注(0.106.0)

- SDK 对「同一 index 被二次 content_block_start」不报错,而是把后续 delta 并进已有块 + 可能推出错位空块——**宽容但静默错**。故 wire 正确性**不能靠 SDK 报错兜底**,必须 producer 侧算对 offset(独立 oracle 原则)。

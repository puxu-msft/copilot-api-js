# Subagent Review 报告 #02：对抗红队（general-purpose）

- 日期：2026-07-07
- 对象：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md)
- 裁判轴（prompt 指定）：长远正确 + 完整；重点猎杀「永久误删好数据 / 静默吞错 / onResolved 误归因」；亲手取证不轻信 spec。
- 结论：**不能安全进入实施。核心安全声明建立在混淆实验上，精确定位主路径无法构建、真实样本上退化 strip-all 或误学，接入点指向退役管线，根因假设未证伪。**

## 取证确认（jq 亲测真实文件）
- 400 body 实为 `messages.3.content.34: thinking...cannot be modified`（request_id `req_011CcnZuf52b6cvY4Rw88KyB`）；`messages[3]`=4 块 user，`content.34` 不映射我方 payload。
- 27 thinking 块，明文长度**全 0**，signature 长 ~2168、**27 个全不同**（unique==27）。
- thinking 分布 msg[2..219]；**最后 assistant 消息 msg[238] 有 0 个 thinking 块**；含 thinking 最高 = msg[219]；msg[221..238] 全 text+tool_use 无 thinking。
- `10703`（strip-all 后）：0 thinking 块、`success:true`。
- 全仓**无任何 GHC message collapse/fold/merge 逻辑**。
- 活路径 = route → handler-v4 → driver；DESIGN.md 明写 `request/pipeline` `[退役中]`、仅 web_search 消费；v4 策略清单在 `codec/anthropic/strategies.ts:84`（13 条经 adaptLegacyStrategy）。

## CRITICAL

**B-C1. onResolved 确认是混淆实验 → 永久误删好 signature**。识别=「剥猜测块 G → 重试一次 → 200 就落库」。但这次重试同时改了两个变量：(a) 移除 G、(b) 对上游重掷一发。spec §1 自述 400「偶尔」触发（intermittent）→ 单次 stripped-retry 得 200 **不能证明 G 有罪**，很可能上游这发恰好健康 → 把好 signature G 永久写进 durable quarantine，跨重启、所有对话里 G 的块被静默剥掉。**更深**：即便 400 确定性，移除任一块都改变后续块坐标 + GHC 折叠后 latest-assistant 边界；真凶是别的块时，移除 G 让边界移动排除真凶也得 200 → 误指 G。单次 stripped-retry 无法区分「G 有罪」与「移除任一块改了折叠形状」。修：确认须有**对照臂**（不剥仍 400 + 剥后 200 双证确定性），或连剥取确定性，或只在 strip-all 也失败时用二分得可证伪定位。「200 才落库」的安全感是假的。

**B-C2. 索引首选路径无法构建 → 方案 A 实质退化 strip-all**。全仓无折叠逻辑可参考；唯一真实样本上索引给出错误答案（映射到 msg[25]，与「latest assistant」矛盾）→ 首选路径永远退化 fallback。**fallback 也破**：fallback=「payload latest assistant message 的 thinking」，真实 latest assistant=msg[238] **0 个 thinking 块** → 候选空 → 不剥 → 仍 400 → strip-all。宽松解释成 msg[219]（1 块）也覆盖不到 GHC 折叠后跨大 span 的真凶。净结果：真实语料上方案 A 要么等于 strip-all 且永不 durable 学到东西，要么（配合 C1）学到错的。修：GHC-collapse 近似可行性 PoC 列为前置门禁；不可行则主路径改「strip-all 解锁 + 二分定位 + 二分 200 才落库」，二分从暂缓提进主范围。

## HIGH

**B-H1. 接入点指向 `[退役中]` legacy pipeline，活路径不跑**（与架构评审 A1 收敛）。修：接 v4 `codec/anthropic/strategies.ts` + onResolved 用 `pipeline/types.ts` 语义；注意 driver `activeStrategy` last-wins 归因窗口（strip 后又 token-refresh 则我方 onResolved 不触发）。

**B-H2. 根因未证：可能是我方 pipeline 改了 thinking 块，而非 signature 内在中毒**（root-cause-over-patch）。错误文案「must remain as they were in the original response」= 「你改了 latest assistant 的 thinking」。真凶可能是我方 sanitize/rewrite 链（dedup/system-merge/thinking-signature-compat rewrite/相邻块编辑）在传输中改动折叠后 latest-assistant 内容/顺序。若如此，quarantine 一个 signature 是治我方自伤的症状，真修=让某 sanitize pass 别碰 latest assistant。CC strip-all 成功与「任何对折叠 latest-assistant thinking 的改动都触发、全剥即避开」一致，**不能证明存在单个坏 signature**。修：impl 期先做对照 PoC——原样透传（不经 sanitize）同一 payload 是否仍 400？透传不 400、经 sanitize 才 400 → 根因是我方修改，方案应改向。

**B-H3. 主动过滤命中不更新 last_seen_at → 生效中的 quarantine 被 LRU 淘汰 → 抖动**。真坏 signature 被 quarantine 后每轮发送前就过滤、永不再 400 → last_seen_at 停在首次学到时刻 → 成「最旧」被淘汰 → 又被发出 → 400 → 重学。quarantine 越有效越会被淘汰，周期性抖动。修：过滤命中必须写穿透 bump last_seen_at + hit_count。

## MEDIUM
- B-M1. 复用 `connection.ts` 单例会砸 history DB 句柄（与 A3 收敛）→ 用独立连接实例。
- B-M2. 多进程 hot-cache 不一致：WAL+busy_timeout 挡住损坏（good），但进程 A 学到、进程 B 重启前不知 → B 持续重学。写进不变量为可接受取舍。
- B-M3. matcher 双 token 需显式负样本（`thinking.type.enabled`、未来含「cannot be modified」非 thinking 的 400）防吞错误伤。

## LOW
- B-L1. fallback「latest assistant message」定义歧义（msg[238] vs msg[219]），真实样本两解释都覆盖不到真凶。
- B-L2. §7 自相矛盾：collapse 映射列暂缓，§3.2 却当首选主路径。
- B-L3. §2 未采纳表「strip-all + 全集隔离」理由与方案 A 实测退化行为冲突，需 record-not-adopted 补实测。

## 进入实施前至少补齐的硬约束
1. 确认须有对照臂才落库（修 C1 假 oracle）。
2. 先 PoC 证 GHC-collapse 索引→signature 映射可构建；不可行则主路径改 strip-all+二分（二分 200 才落库）。
3. 接入点改 v4 codec/anthropic/strategies.ts + pipeline/types.ts onResolved，写明 activeStrategy last-wins 归因窗口。
4. 先做透传 vs 经 sanitize 对照 PoC 排除我方自伤根因。
5. 过滤命中 bump last_seen_at 防 LRU 抖动。
6. sidecar 独立连接实例；写明多进程最终一致取舍。

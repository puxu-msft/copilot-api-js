# Subagent Review 报告 #03：v2「会话级 strip-all + TTL」spec（架构 + 对抗）

- 日期：2026-07-07
- 对象：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md) v2
- 裁判轴（prompt 指定）：长远正确 + 完整 > 短期将就；亦不把已被证据排除的复杂方案硬塞回；亲手核对代码锚点。
- 结论：**接近可实施，2 阻塞项修正后可进 TDD 计划。** 无 CRITICAL。

## #1 key 时点：证伪（spec 是对的）
预设「session/agent 在 sanitize 时点还没 set」不成立。ctx 在 `parseAnthropic`（S1）诞生即带 session/agent（`codec/anthropic/codec.ts:286-293`）；sanitize 是 S3 RequestRewrite，`apply(env)` 拿到的 `env.ctx` 已填（`request-rewrite-adapter.ts:62-65`）。anthropic messages 的 session 纯来自 header（不像 responses 要等 response.id）。→ 主动过滤与反应式策略在各自执行点都能从 env.ctx 拿稳定 (session, agent)。

## HIGH（阻塞）

**HIGH-1. §4.2 落库机制自相矛盾、不可行**（主会话已亲自复核确认）。spec 要 legacy-wrap（`adaptLegacyStrategy`）+ onResolved 读 ctx；但 legacy `ResolvedContext`（`pipeline.ts:154-164`）= `{payload,prepareHints,meta,attempt}` **无 ctx**，`adaptLegacyStrategy` onResolved 桥接**丢弃 env**（`legacy-strategy-adapter.ts:100-103`）。key=(session,agent) 只在 ctx → legacy 够不到 → **store 永远写不进 → 主动过滤永不命中 → 所有会话退化为每轮先 400 再 reactive**，durable 价值静默失效。`createServerToolRejectionStrategy` key=model（payload）故能用 legacy，**非本策略模板**。修：写**原生 env-strategy**，`handle(error,env)`/`onResolved(env,meta)` 读 `env.ctx`（driver `onResolved(current,...)` 传带 ctx 的 env，`driver.ts:283`/`types.ts:137`）。→ **已修入 spec §4.2**。

## MEDIUM

**MEDIUM-1. §4.3 主动过滤不能塞进 `sanitizeAnthropicMessages`**（纯函数、只收 payload、无 ctx，`sanitize/index.ts:79`）。修：独立 env-aware `RequestRewrite`（`apply:(env)=>读 env.ctx`）挂 `codec.getRequestRewrites()`，同构 `createAnthropicSanitizeRewrite`。→ **已修入 §4.3**。

**MEDIUM-2. 一个 RequestRewrite 覆盖不了 web_search**（后者整体绕过 driver，`handler-v4.ts:211-225`「codec bypassed entirely」）。修：**双接入点**——driver RequestRewrite + web_search handler 侧显式剥，与反应式「辅接 legacy」对称。→ **已修入 §4.3**。

**MEDIUM-3. 非 CC 降级是每轮永久多一次 400+重试往返**（非一次性）。真正受影响=不自剥的非 CC 客户端。建议 §8 显式记每轮成本 + 内容寻址 fallback key 的暂缓理由。→ **已修入 §8**。

## LOW
- **LOW-1**：v2 放弃 PoC 硬约束 #2（落库前对照臂双证），放宽合理（会话级低伤害 + 窄 matcher 因果 oracle + 自动过期）但须显式 record-not-adopted。→ **已修入 §4.2**。
- **LOW-2**：活跃长会话 compact 掉毒块后仍被剥的残留——**明确不加自愈探针**（会在健康请求引发 400 RTT，得不偿失），记为已知低伤害、TTL 兜底。→ **已修入 §6**。
- **LOW-3**：`learning:true` 预算 `MAX_LEARNING_RETRIES=32` 充足，一次性守卫 OK。

## §4.1 补强
`createDatabase` **不做 PRAGMA/mkdir**（全在 openDatabase），故 §4.1「自建最小 init（mkdir + WAL/busy_timeout + 建表）」是**必须**的（spec 已写明 ✓）。

## v1 六问在 v2 的消解（逐条对照代码确认）
- A1 接线 v4：已解决（`strategies.ts:84` 活装配、ctx 在 parse 就绪）；唯一未尽是 HIGH-1 的策略接口选择。
- A2 redacted 无 signature：已消解（strip-all 按 type 剥，覆盖 redacted）。
- A3 sidecar 独立：已核实（`createDatabase` 零单例副作用，`driver.ts:122-124`；spec 正确避开 `connection.ts:openDatabase`）。
- C1 混淆：已消解（PoC 确定性 + 窄 matcher + 会话级低伤害）。
- C2 索引：彻底作废（v2 不碰索引）。
- H3 命中刷新 TTL：已解决（§4.3+§6 明写主动命中即 bump last_seen）。

## 进入实施前硬约束
1.（阻塞）HIGH-1：原生 env-strategy 落库。→ 已修
2.（阻塞）MEDIUM-1/2：独立 env-aware RequestRewrite + driver/web_search 双接入点。→ 已修
3.（收尾）LOW-1 record-not-adopted；MEDIUM-3 §8 成本+fallback。→ 已修
补齐后设计形状（会话级 strip-all + 3d 滑动 TTL + 独立 sidecar + never-throw 热缓存）健壮、确定性有效、服务端化，可进 TDD。追加测试：原生 env-strategy onResolved 读 ctx 落库的接线守卫 + web_search 主动过滤命中测试。

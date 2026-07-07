# Spec: Thinking Signature 隔离（quarantine）机制

- 状态：**BLOCKED — 两份对抗 subagent 评审收敛出 3 条承重问题，方案 A 在真实语料上不成立，待用户定方向**。评审报告：[#01 架构](2026-07-07-thinking-signature-quarantine-review-2026-07-07-01.md) / [#02 红队](2026-07-07-thinking-signature-quarantine-review-2026-07-07-02.md)。承重问题：① 接入点接到退役管线（活路径是 v4 codec/anthropic/strategies.ts）；② 索引首选路径无折叠逻辑可参考、真实样本上不映射、fallback 候选为空 → 退化 strip-all 或误学；③ 「200 才落库」是混淆实验（相关非因果）+ 根因未证（可能是我方 sanitize 改了 latest-assistant thinking，非 signature 内在中毒）。下文正文为初版设计，尚未按评审修订。
- 日期：2026-07-07
- 归属：`docs/spec/`；ADR 若需另立于 `docs/decisions/`；实施计划落 `docs/plan/`。
- 相关 skill：`ghc-anthropic-upstream`（本症状调试）、`empirical-verification`、`persistence-async-invariants`、`telemetry-architecture`、`history-sqlite-schema`。

## 1. 问题（What & Why）

GHC 上游偶尔对某个 thinking 块返回 400：

```
messages.N.content.M: `thinking` or `redacted_thinking` blocks in the latest
assistant message cannot be modified. These blocks must remain as they were in
the original response.
```

某个 thinking 块的 `signature` 中毒（上游自身无法验证），而它被固化在**客户端历史**里，之后每一轮都随历史重发、每轮都撞同一个 400。

**现状兜底**（要超越的基线）：Claude Code 客户端把整轮**全部** thinking 块无差别剥掉再重发。真实取证（`req_1783421417879_10702`＝失败 / `req_1783421419609_10703`＝清理后成功）：失败请求 27 个 thinking 块 → 清理后 0 个，27 个全被牺牲。三点实证事实：

1. 27 个 thinking 块**全是空明文**（`thinking` 文本长度 = 0，opus-4.8 常态：只发 `signature_delta`）。真正的推理文本本就不可见，剥离一个块只损失 signature/缓存连续性，**不损失可见推理** → 过度剥离是**低伤害**，但仍应尽量只剥坏块。
2. 报错里的 `messages.N.content.M` 是 **GHC 把我们的 240 条消息折叠成约 4 条之后**的坐标，**不映射**回我们发出的 payload（实测：我们的 `messages[3]` 是 4 块的 user 消息；无任何消息有 ≥35 块；「拼接所有 assistant 块数到 34」落在**早期**第 25 条消息的块上，与报错所说「latest assistant message」矛盾 → 巧合，指向错误的好块）。
3. pipeline 已有独立的 **learning-retry 预算**（`driver.ts` 的 `maxLearningRetries`，与普通重试预算分离）和 **`onResolved` 钩子**（`request/pipeline.ts:166`，「后续 attempt 成功时提交 learning」），为「即时重试 + 成功才落库」提供原生支撑。

**目标**：基于 `signature` 精确隔离坏块——检测 400 → 定位坏 signature → 本轮即时自愈 → 持久记录 → 后续轮次发出前主动过滤掉它，**保留其余好块**，且**跨重启**仍生效、**任意客户端**（不止 CC）都受益。

## 2. 设计决策（已与用户敲定）

| 维度 | 决策 | 理由 |
|---|---|---|
| 失败轮处理 | 记录坏 signature + **即时重试本轮** | 本轮就自愈，不把失败甩给客户端 |
| 存储生命周期 | **持久化**到专用 sidecar，**独立于 history 开关** | history 可被关闭（`history/entries.ts:70`），而过滤须常驻 |
| 启用方式 | **config 开关，默认开** | 与项目多数 sanitize 行为一致，留逃生阀 |
| 识别策略 | **方案 A：索引引导 + 免费确认** | 以报错索引为首选猜测（采信其精度），用「本就要做的即时重试」免费验证，**200 才落库**，避免误删好块 |

**未采纳的备选（`record-not-adopted`）**：

- *直接采信索引映射、不验证*：上游调用最少，但 §1.2 已实证该映射对真实请求给出矛盾/错误结果，会**永久误删好 signature**（无自验证，违 `empirical-verification`）。
- *纯二分搜索（不用索引）*：最鲁棒但放弃报错里的精度信息，且首次中毒时多几次全量上行。方案 A 已把索引作为首选、二分仅作 400 后的兜底路径，故不必默认纯二分。
- *strip-all + 全集隔离*：最简，但对本会话等价于 strip-all（隔离 27 个），未实现「保留好块」的本意。
- *tail-run 一次性剥离*：GHC 合并边界不透明，尾部边界启发式可能偏大/偏小，不可靠。

## 3. 架构（四组件）

### 3.1 持久隔离存储 `src/lib/anthropic/thinking-quarantine/store.ts`

- **专用 sidecar SQLite**：`~/.local/share/copilot-api/thinking-quarantine.db`（路径经 `config/paths.ts`，遵循 `XDG_DATA_HOME`），**独立**于 history DB 与 `history.enabled`。runtime-agnostic 开库沿用 `history/sqlite/connection.ts` 的 bun:sqlite / node:sqlite 选择模式。
- 表 `quarantined_signatures(signature TEXT PRIMARY KEY, first_seen_at INTEGER, last_seen_at INTEGER, hit_count INTEGER, last_error_sample TEXT)` —— 富存储可诊断（`richest-data-flow` + 内部工具全量暴露）。
- **有界 LRU**：cap（默认 ~1000），超限按 `last_seen_at` 淘汰最旧。坏 signature 是稳定确定性的，误标风险低，LRU 天然老化兜底。
- **内存热缓存**：`state` 持有 `Set<string>`（signature 全串，按相等比较），boot 时从 sidecar 水合；新增/命中写穿透 sidecar。
- **never-throw**：持久化 fire-and-forget，异常只 warn 不抛；过滤只读内存，sidecar 不可用时降级为「本进程仍学习、重启丢失」而非崩溃（`persistence-async-invariants`）。

### 3.2 反应式检测 + 即时重试策略 `src/lib/request/strategies/bad-thinking-signature-retry.ts`

接入 `buildAnthropicStrategies`（`anthropic/pipeline.ts:170`），排在其他 400-class 策略中（其 body 匹配与它们互斥）。per-request 一次性守卫 + escalation 状态。

- **matcher**：守卫式匹配该 400 body——要求同时命中 `thinking`/`redacted_thinking` 与 `cannot be modified`（仿 `legacy-thinking-retry` 的双 token 校验，避免误伤无关 400，如 `thinking.type.enabled`）。解析 `messages.N.content.M`。
- **识别（方案 A）**：
  1. **索引引导猜测**：用 `content.M` + 一份 GHC-collapse 近似，映射到「最可能的元凶 thinking 块」的 signature（首选路径，采信索引）。近似不可得/越界时，退化为「payload 中 latest assistant message 的 thinking signatures」候选。
  2. **即时重试**（`learning: true`，走 learning 预算）：剥掉猜测的那个块后重试。**这个重试本就为解锁本轮而必须做**。
  3. **免费确认（onResolved）**：把候选 signature 暂存在策略实例；`onResolved`（仅在后续 attempt 成功时触发）里才写入 sidecar → **200 才落库**（`record-at-committed-outcome`）。
  4. **400 兜底**：猜测的块剥掉后仍 400 → escalate 到 strip-all（保证本轮成功解锁），本轮**不落库**（不拿被证伪的猜测毒化持久集）。
- **abort/never-throw**：策略自身异常按 driver 既有语义降级为原始错误；不吞错。

### 3.3 主动过滤 `src/lib/anthropic/sanitize/bad-thinking-signature.ts`

接入 `sanitizeAnthropicMessages`（`anthropic/sanitize/index.ts:79`），置于 `processToolBlocks` 之前（空消息交由其既有清理）。

- 丢弃**任意消息**中 `signature ∈ 隔离集` 的 `thinking`/`redacted_thinking` 块（signature 自包含 → 坏则处处坏；`thinking-protection.ts` 已证实自包含性）。
- 结构安全：丢一个已知坏块，比发它更安全（归档结论「不发送比发送被修改的更安全」）。
- **config 门禁**：`state.badThinkingSignatureFilter`（默认 true）。
- **telemetry**：过滤计数（沿用 `observability/telemetry-dimensions.ts` 既有 thinking-sanitize 维度风格）。

### 3.4 配置开关

- schema：`anthropic.bad_thinking_signature_filter`（boolean，默认 `true`），加入 `config/schema.ts` + `config/config.ts` + `bundled config.yaml` 文档。
- state：`badThinkingSignatureFilter` 字段 + 默认值，随 config 应用。

## 4. 数据流

- **第 N 轮（首次中毒）**：sanitize（尚无已知坏，不动）→ 发出 → 400 → 策略解析索引、猜元凶、剥它、`learning` 重试 → **200** → `onResolved` 把该 signature 落 sidecar。（猜错则 400 → strip-all 解锁、不落库。）
- **第 N+1 轮起**：sanitize 发出前就丢掉 `signature ∈ 隔离集` 的块 → **不再触发 400**，其余好块保留。
- **跨重启**：boot 水合 sidecar → N+1 轮依旧被过滤。

## 5. 错误处理 / 不变量

- 持久化 **never-throw**、fire-and-forget；过滤只读内存缓存。
- 反应式策略 **per-request 一次性 + escalation 计数**，request-scoped 不跨请求泄漏。
- **200 才落库**（onResolved 提交），400 兜底不落库。
- 隔离集 **有界 LRU**。
- 不吞错：matcher 只窄匹配目标 400，其余 400 原样交后续策略/上游。

## 6. 测试（TDD）

- **单元**：
  - matcher：对真实 body（§1）正命中；对 `thinking.type.enabled`、无关 400 负命中；正确解析 `messages.N.content.M`。
  - 索引→signature 近似映射：给定构造 payload，映射落在预期块；越界/不可得时退化到 latest-assistant 候选。
  - 主动过滤：只丢隔离集内块、保留其余、drop 后空消息交下游清理。
- **存储**：水合 / 写穿透 / LRU 淘汰 / never-throw；临时目录 DI 隔离（`test-isolation` skill，Bun `os.homedir()` 忽略 `env.HOME` → 必须注入）。
- **集成**：
  - **200 才落库**：mock 重试 200（落库）vs 重试仍 400（strip-all 兜底、不落库）两条路径。
  - config 门禁开/关。
  - onResolved 只在成功 attempt 触发。
- **实证（impl 期，`empirical-verification`）**：用 4141 history / 本地探针复现真实 400 措辞集合；确认「剥掉猜测块 → 200」在真实请求上成立；GHC-collapse 近似的命中率取真实语料标定。

## 7. 明确暂缓（记入 `docs/todo/deferred-backlog.md`，非本 spec 范围）

- **二分搜索精化**：索引猜错、strip-all 兜底后，用 learning 预算做二分定位真正元凶并落库（当前：猜错即本轮不学习，下轮再撞一次）。
- **GHC-collapse 映射的持续标定**：随上游折叠行为漂移时更新近似；命中率作为可观测指标暴露。
- **context-editing 回执 telemetry** 等既有暂缓项不受影响。

## 8. 与现有机制的关系

- 与 `thinkingBlockSanitizeCheck`（空明文+签名启发式过滤）、`thinking_block_message_policy: stripped`（无差别剥旧块）**正交组合**：本机制是**精确按已知坏 signature** 过滤，不替代它们。
- 与 `thinking-protection.ts` 的「保护 thinking 不被结构性改动」不冲突：主动过滤是**有意的、安全的移除**（已知坏块），不属于「误改」。

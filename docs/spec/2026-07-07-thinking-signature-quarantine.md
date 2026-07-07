# Spec: thinking「cannot be modified」400 三层防治（collapse + reactive + session quarantine）

- 状态：draft **v4（三层叠加：结构 collapse 主修 + reactive strip-all 兜底 + session-key/TTL 持久 quarantine）**。待 subagent 复审 → 用户 review → 实施计划。
- 日期：2026-07-07
- 演进：v1（signature+索引+二分，废）→ v2/v2.1（会话级 strip-all + TTL）→ v3（纯结构 collapse，**因过度简化被否**）→ **v4（三层：结构精确修 + reactive 兜底 + 会话 quarantine 全保留）**。评审存证 [#01](2026-07-07-thinking-signature-quarantine-review-2026-07-07-01.md)/[#02](2026-07-07-thinking-signature-quarantine-review-2026-07-07-02.md)/[#03](2026-07-07-thinking-signature-quarantine-review-2026-07-07-03.md)；PoC [exp/thinking-signature-quarantine/README.md](../../exp/thinking-signature-quarantine/README.md)。
- 相关 skill：`ghc-anthropic-upstream`、`empirical-verification`、`persistence-async-invariants`、`history-sqlite-schema`、`test-isolation`。

## 1. 问题 + PoC 锁定的精确根因

GHC 上游对某些请求返回确定性 400：
```
messages.N.content.M: `thinking` or `redacted_thinking` blocks in the latest
assistant message cannot be modified. These blocks must remain as they were in
the original response.
```

**PoC 决定性结论（详见 exp/ README）**：
- **根因（本样本）= 一条（GHC 折叠后）assistant 消息含 ≥2 个连续 thinking 块**。真实失败请求里唯一含多 thinking 块的 msg 14（3 个连续）正是元凶；保留任意 1 个 → 200、保留 ≥2 → 400、保留 0 → 200。三块本身不畸形。客户端把本应交替的 thinking 错误累积/前置成连续块，上游判「已修改」。
- **拆分救不了**：把 msg14 拆成 3 条连续 assistant 消息 → GHC 折叠回 `[T,T,T]` → 仍 400（实测 `pb_split3`）。→ **唯一结构修 = 连续 run 折叠为首块**（record-not-adopted：split）。
- **确定性**（原样 ×3 全 400）、**非我方所致**（inbound==outbound 全量逐条相同）。
- **其他中毒模式存在**：skill `ghc-anthropic-upstream` 记载单块签名内在对不上等；本 PoC 仅 1 样本无法穷尽 → 需兜底 + 持久记忆。

## 2. 三层防治（互补，非替代）

| 层 | 机制 | 覆盖 | 状态 |
|---|---|---|---|
| **L1 结构 collapse**（主修，提前精确） | 无状态 sanitize：连续 thinking run 折叠为首块 | 高发的「多重性」毒；**保留 1 块 thinking**，零 400 往返 | 无状态 |
| **L2 reactive strip-all**（兜底，解锁本轮） | 命中「cannot be modified」400 → strip-all thinking 重试一次 | L1 没预防到的其他型毒（漏网/非多重性） | 无状态 |
| **L3 session quarantine**（持久记忆，免复发往返） | 记 `(session_id, agent_id)`@now；该会话 3d 滑动 TTL 内提前 strip-all | 非 L1 型毒的**会话级复发**（否则每轮都 L2 一次 400+重试） | 持久 sidecar |

L1 精确修高发毒（保留 thinking）；L2 接住漏网、保证本轮成功；L3（**用户明确要求无论如何保留**）记住会话、免非-L1 型毒每轮复发的 400+重试往返。

## 3. 架构

### 3.1 L1 结构 collapse `src/lib/anthropic/sanitize/collapse-consecutive-thinking.ts`
- 规则：每条 assistant 消息 content 里，**极大连续 run（相邻 ≥2 个 `thinking`/`redacted_thinking`）折叠为首块**、丢其余。**只动连续 run**，不误伤被 tool_use 隔开的合法 interleaved thinking、不动单 thinking 消息、不动非 thinking 块。
- 纯函数（payload-only），接入 [sanitizeAnthropicMessages](../../src/lib/anthropic/sanitize/index.ts#L79)（`processToolBlocks` 之前）——**一处覆盖 driver S3 + web_search 双路径**（评审 A6）。按 `type` 判定覆盖 redacted（评审 A2）。PoC 证留首块 → 200。
- config 门禁 + telemetry（折叠 run 数 / 丢块数）。

### 3.2 L2 + L3 反应式策略 `src/lib/codec/anthropic/poisoned-thinking-retry.ts`
- **必须原生 env-strategy**（非 `adaptLegacyStrategy`）——落库 key=`(session_id,agent_id)` 只在 `env.ctx`，legacy `ResolvedContext` 无 ctx、adapter 丢 env（评审 HIGH-1，已复核 [pipeline.ts:154](../../src/lib/request/pipeline.ts#L154)/[legacy-strategy-adapter.ts:100](../../src/lib/pipeline/legacy-strategy-adapter.ts#L100)）。原生 `handle(error,env)`/`onResolved(env,meta)` 读 `env.ctx`（driver `onResolved(current,…)` 传带 ctx 的 env，[driver.ts:283](../../src/lib/pipeline/driver.ts#L283)/[types.ts:137](../../src/lib/pipeline/types.ts#L137)）。
- 接入 v4 活路径 [codec/anthropic/strategies.ts:84](../../src/lib/codec/anthropic/strategies.ts#L84)（直连主流量，评审 A1）+ 辅接 legacy `anthropic/pipeline.ts:170`（web_search 双跳，legacy 孪生或共享 remediation）。
- **matcher**：守卫式双 token（`thinking`/`redacted_thinking` + `cannot be modified`，仿 [legacy-thinking-retry](../../src/lib/request/strategies/legacy-thinking-retry.ts#L36)，避免误伤 `thinking.type.enabled`；评审 M3 负样本测试）。per-request 一次性。
- **L2 remediate**：strip-all thinking（含 redacted）→ 重试一次（`learning:true`，`MAX_LEARNING_RETRIES=32` 足）。PoC 证 → 200。
- **L3 落库（onResolved，成功才记）**：从 `env.ctx` 读 `(session_id, agent_id)` 写 sidecar（now/hit_count++/error_sample）。无 session_id → 跳过落库（仅 L2 解锁，降级）。归因混淆会话级无害（误记最坏剥该会话 thinking ≤3d 滑动，空明文低伤害、自动过期）；**（record-not-adopted）** 有意不采纳 PoC 对照臂双证（会话级低伤害 + 窄 matcher 使 strip-all→200 即有效 oracle + 自动过期）。

### 3.3 L3 持久 quarantine 存储 `src/lib/anthropic/thinking-quarantine/store.ts`
- **专用 sidecar SQLite** `~/.local/share/copilot-api/thinking-quarantine.db`，独立于 `history.enabled`。**禁用** `connection.ts:openDatabase`（单例会关 history 库，评审 A3/M1）；用 [sqlite/driver.ts:createDatabase](../../src/lib/history/sqlite/driver.ts#L122)（无单例副作用）+ **自建最小 init**（mkdir + WAL/busy_timeout + 建表——createDatabase 不做 PRAGMA/mkdir，必须自建，评审补强）。
- 表 `poisoned_conversations(session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', first_seen_at, last_seen_at, hit_count, last_error_sample, PRIMARY KEY(session_id, agent_id))`。主 agent 归一 `agent_id=''`（NULL 在 PK 视作互异）。
- **3 天滑动 TTL**：读时 `now-last_seen_at>TTL` 视过期；命中有效即 bump `last_seen_at`（滑动续期，评审 H3）。惰性 + 周期 purge 过期；安全 cap 防极端。
- 内存热缓存 `Map<"session\0agent", last_seen_at>`，boot 水合、写穿透。**never-throw** fire-and-forget，过滤只读内存（`persistence-async-invariants`）。

### 3.4 L3 主动 strip-all 过滤（独立 env-aware RequestRewrite，**双接入点**）
- 语义：请求进入时若 `(session_id, agent_id)` ∈ store 且未过期 → strip-all thinking（含 redacted）后送上游 + bump `last_seen_at`。
- **必须独立 env-aware `RequestRewrite`**（`apply:(env)=>读 env.ctx.sessionId/agentId`），非塞进无 ctx 的纯 `sanitizeAnthropicMessages`（评审 MEDIUM-1）；同构 `createAnthropicSanitizeRewrite`、挂 `codec.getRequestRewrites()`（[request-rewrite-adapter.ts:63](../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L63)）。
- **双接入点**（web_search 整体绕过 driver，[handler-v4.ts:211](../../src/routes/messages/handler-v4.ts#L211)「codec bypassed」，评审 MEDIUM-2）：driver RequestRewrite + web_search handler 侧显式剥。
- 注：L3 主动过滤命中即整体 strip-all（比 L1 collapse 更宽）；对已知中毒会话不必依赖 L1 精确性。

### 3.5 配置
- `anthropic.collapse_consecutive_thinking`（bool，默认 `true`，L1）
- `anthropic.strip_thinking_on_reject`（bool，默认 `true`，L2）
- `anthropic.poisoned_thinking_quarantine`（bool，默认 `true`，L3）+ `anthropic.poisoned_thinking_ttl_hours`（number，默认 `72`）
- schema + state + bundled config.yaml + config 应用。

## 4. 数据流
- **多重性毒请求**：L1 折叠 → 200（提前，无 400、无 quarantine）。← 高发路径，最省。
- **非-L1 型毒，首轮**：L1 不动 → 发出 → 400 → L2 strip-all 重试 → 200 → L3 记 `(session,agent)`。
- **非-L1 型毒，次轮起（TTL 内）**：L3 主动 strip-all + 刷新 TTL → 零 400。
- **3d 无活动**：TTL 过期 purge → 恢复常态（毒仍在则重学一次）。
- 跨重启：sidecar 水合，L3 继续。

## 5. 不变量 / 错误处理
- L1 纯函数确定性、只动连续 run。
- L2 per-request 一次性、strip-all 走 learning 预算。
- L3 落库读 env.ctx（原生 env-strategy）；主动过滤命中必 bump last_seen（否则活跃中毒会话过期重撞）；持久化 never-throw、过滤读内存缓存。
- 无 session_id → L2 仍解锁、L3 跳过（降级，不阻塞）。
- matcher 窄匹配不吞其他 400。
- 多进程：WAL+busy_timeout 防损坏、内存缓存经 sidecar 最终一致（进程 A 学 B 重启前经 L2 自愈；文档化取舍，评审 M2）。
- **已知残留**（评审 LOW-2）：活跃长会话被 compact 掉毒块后 L3 仍剥至 TTL 过期；**不加自愈探针**（会在健康请求引发 400 RTT）；空明文低伤害 + TTL 兜底。

## 6. 测试（TDD）
- **L1 单元**：`[T,T,T,text,tool]`→`[T,text,tool]`；`[T,tool,T,tool]` interleaved 不动；单 T 不动；redacted run 折叠；多不相邻 run 各折叠；user 消息不动；**split 不修**（回归钉死 GHC 折回、不采纳 split）。
- **L2 单元**：matcher 正/负样本（`thinking.type.enabled` 负命中）；strip-all 移除 thinking+redacted 保留其余。
- **L3 存储**：createDatabase 独立库（不碰 history 单例）；水合/写穿透/TTL 滑动+purge/never-throw；**临时目录 DI**（Bun `os.homedir()` 忽略 `env.HOME`，记忆 `feedback_tests_never_touch_real_env`）；key 归一（主 agent→'')。
- **集成**：L1 折叠请求直接 200（不触发 L2/L3）；非-L1 毒 首轮 400→L2→200→L3 落库、次轮 L3 主动 strip-all+TTL 刷新；无 session_id 降级；三 config 门禁；**接线守卫**——原生 env-strategy onResolved 从 env.ctx 读 (session,agent) 落库（锚 HIGH-1）+ web_search 主动过滤命中（锚 MEDIUM-2）+ v4 直连激活（handler-v4 路径，非 legacy）。
- **实证**：PoC 已证 留1块/strip-all→200、确定性 400、split 不修；impl 期 :4141 复跑守 matcher + 折叠规则。

## 7. 暂缓（记 docs/todo）
- 非 CC 客户端 durable key（无 `x-claude-code-session-id`→每轮 L2 一次 400+重试；内容寻址 fallback key 暂缓，评审 MEDIUM-3；若做：store key 泛化 `header-key|content-hash-key`）。
- 跨进程即时缓存失效（当前重启/L2 最终一致）。
- 上游根因反馈（CC 产生连续 thinking 的行为治本在 CC 侧，非本项目）。

## 8. 与现有机制关系
- 与 `thinkingBlockSanitizeCheck`/`thinking_block_message_policy`/`thinking-signature-compat` 正交。
- 与 `thinking-protection.ts`（防误改 thinking）不冲突：L1 折叠**有意移除被证伪的连续冗余 thinking**（发它必 400），非「误删合法 thinking」；impl 需核对折叠 pass 在 protection 语义下被允许（连续冗余不属「必须保留」）。
- PoC 证根因上游 intrinsic（非我方 sanitize），故不替代任何「别碰 latest-assistant」保护。

## 9. 路线图定位：L3 是「会话级连续请求处理」的基础能力（重要未来分支）

L3 的 `(session_id, agent_id)` 持久层**不是本 feature 的一次性补丁，而是未来「基于会话的连续请求处理」方向的第一块基石**（用户明确定为重要未来分支）。设计约束（`against-yagni` 对真实迭代路线 + `richest-data-flow`）：
- **key 作为可复用 primitive**：`(session_id, agent_id)` 归一/查询/落库封装成独立模块（`thinking-quarantine/store.ts` 内的 session-key helper 或抽到 `session-state/`），供未来会话级特性复用，而非内联进 quarantine 逻辑。
- **store 不过度窄化**：sidecar 表虽当前只承载 `poisoned_conversations`，但连接/迁移/热缓存/TTL 骨架应可容纳未来 per-conversation state（例如会话级偏好、累积上下文指纹、连续请求去重/幂等标记）——即「会话级 KV/状态」形态，而非写死单表单用途。impl 期用现有 sidecar init 骨架时保留这一扩展余地（不预建未用表，但不设计成无法扩展）。
- **未来分支候选**（记 docs/todo，不在本 spec 实现）：会话级连续请求的幂等/去重、跨轮上下文累积与压缩决策、会话级路由/模型粘滞、会话级遥测聚合。这些都以 `(session_id, agent_id)` 为共享 key。
- **暂不过度设计**：本 spec 只落地 L3 的 quarantine 用途；但**不把 store/key 设计成只能干这一件事**。具体未来特性到来时各自 spec。


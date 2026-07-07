# Spec: thinking「cannot be modified」400 三层防治（de-stack + reactive + session quarantine）

- 状态：draft **v4（三层叠加：结构 de-stack 主修〔保留全部 thinking〕 + reactive strip-all 兜底 + session-key/TTL 持久 quarantine）**。待 subagent 复审 → 用户 review → 实施计划。
- 日期：2026-07-07
- 演进：v1（signature+索引+二分，废）→ v2/v2.1（会话级 strip-all + TTL）→ v3（纯结构 collapse，**因过度简化被否**）→ **v4（三层：结构精确 de-stack + reactive 兜底 + 会话 quarantine 全保留）**。评审存证 [#01](2026-07-07-thinking-signature-quarantine-review-2026-07-07-01.md)/[#02](2026-07-07-thinking-signature-quarantine-review-2026-07-07-02.md)/[#03](2026-07-07-thinking-signature-quarantine-review-2026-07-07-03.md)；PoC [exp/thinking-signature-quarantine/README.md](../../exp/thinking-signature-quarantine/README.md)。
- 相关 skill：`ghc-anthropic-upstream`、`empirical-verification`、`persistence-async-invariants`、`history-sqlite-schema`、`test-isolation`。

## 1. 问题 + PoC 锁定的精确根因

GHC 上游对某些请求返回确定性 400：
```
messages.N.content.M: `thinking` or `redacted_thinking` blocks in the latest
assistant message cannot be modified. These blocks must remain as they were in
the original response.
```

**PoC 决定性结论（详见 exp/ README）**：
- **根因（本样本）= 一条（GHC 折叠后）assistant 消息里有两个 thinking 块相邻**。精确约束 = **「同一条折叠后 assistant 消息内任意两个 `thinking`/`redacted_thinking` 块不得相邻」**（非「至多 1 个」）。真实失败请求里唯一含多 thinking 块的 msg 14（`[T,T,T,text,toolA,toolB]`，3 个连续）正是元凶。
- **实测精确定位**：保留任意 1 个 → 200；任意 2 个相邻 → 400；**把 3 个用非 thinking 块交错分隔（`[T,text,T,tool,T,tool]` 等）→ 200 且全保留**；部分相邻（`[T,tool,T,T,tool]`）→ 仍 400。三块本身不畸形、signature 各自有效（自包含、非位置绑定）。客户端把本应交替的 thinking 错误累积/前置成相邻块，上游判「已修改」。
- **拆分救不了**：拆成 3 条连续 assistant 消息 → GHC 折叠回 `[T,T,T]` → 仍 400（`pb_split3`）。→ **修法 = 消息内 de-stack（交错分隔，保留全部 thinking；真实块不足则插非空合成标记，永不丢）**；record-not-adopted：split（无效）、collapse-to-first/丢弃多余（放弃——用非空合成标记分隔即可保全 thinking）。
- **确定性**（原样 ×3 全 400）、**非我方所致**（inbound==outbound 全量逐条相同）。
- **其他中毒模式存在**：skill `ghc-anthropic-upstream` 记载单块签名内在对不上等；本 PoC 仅 1 样本无法穷尽 → 需兜底 + 持久记忆。

## 2. 三层防治（互补，非替代）

| 层 | 机制 | 覆盖 | 状态 |
|---|---|---|---|
| **L1 结构 de-stack**（主修，提前精确） | 无状态 sanitize，**策略可选**（透传 / 插入文本块 / 后移块）：把相邻 thinking 分隔开（**保留全部 thinking**） | 高发的「相邻 thinking」毒；零 400 往返、零数据丢失 | 无状态 |
| **L2 reactive strip-all**（兜底，解锁本轮） | 命中「cannot be modified」400 → strip-all thinking 重试一次 | L1 没预防到的其他型毒（漏网/非多重性） | 无状态 |
| **L3 session quarantine**（持久记忆，免复发往返） | 记 `(session_id, agent_id)`@now；该会话 3d 滑动 TTL 内提前 strip-all | 非 L1 型毒的**会话级复发**（否则每轮都 L2 一次 400+重试） | 持久 sidecar |

L1 精确修高发毒（**de-stack 保留全部 thinking**）；L2 接住漏网、保证本轮成功；L3（**用户明确要求无论如何保留**）记住会话、免非-L1 型毒每轮复发的 400+重试往返。

**架构要点（用户明确）**：
- **L1 是无条件 always-on proactive**——对**每个请求**都跑，**不 gate 在 400 检测上**、不等反应式。安全性依据：de-stack **确定性 + 保序**（thinking 块相对序不变，只在其间插分隔，不重排 thinking 序列 → 满足上游「连续序列不重排」）+ 对无相邻 thinking 的请求是 **no-op** + **永不丢 thinking** + **跨轮严格一致**（同一历史每轮产出同一 de-stack 结果）→ 总是应用**零下风险**，无需先撞 400。
- **反应式基础设施恒需**：L2/L3 依托的 retry-strategy/pipeline 是**共享 infra**，即使 L1 已提前消解「相邻 thinking」这一高发毒，仍需它接住其他中毒模式（skill 记载的单块签名内在对不上等）+ 通用鲁棒性 → **绝不因 L1 覆盖高发路径就裁掉反应式层**。

## 3. 架构

### 3.1 L1 结构 de-stack `src/lib/anthropic/sanitize/destack-adjacent-thinking.ts`
- 精确约束（PoC 实证）：**同一条 assistant 消息内任意两个 `thinking`/`redacted_thinking` 块不得相邻**（非「至多 1 个」）。
- **可选策略（config enum `anthropic.thinking_destack_strategy`）**——对每条含相邻 thinking 的 assistant 消息三选一：
  1. **`passthrough`（透传）**：L1 不动、原样发出，靠 L2/L3 反应式接住。（= L1 关）
  2. **`insert_text`（直接插入文本块）**：相邻 thinking 之间**纯插入非空合成 text 块**分隔，真实块**原位不动**（不重排 tool_use）。最简、不触碰真实块顺序（免 tool 顺序疑虑），代价 = 每对相邻 thinking 加一个合成 text 块。
  3. **`move_blocks`（后移块，默认）**：用消息内**真实**非 thinking 块（text/tool_use）交错分隔相邻 thinking（`[T0,O0,T1,O1,…]`，thinking 首块居首、thinking 组与非thinking 组各自保序）；**真实块不足**（`#thinking > #非thinking+1`）时**补充**非空合成 text 块（永不丢弃 thinking）。零/最少合成污染。
- **分隔符须非空非纯空白**：实测空 `""`/空格 `" "` text 块被上游 strip 掉、thinking 又相邻仍 400（`pb_sep_empty/space`），非空标记 `"[thinking continued]"` → 200（`pb_sep_marker`）；合成标记打可辨识前缀（`synthetic-must-be-distinguishable`）。
- 三策略共性：**保序**（thinking 块内容不改、相对序不变）、只动「存在相邻 thinking」的消息（合法 interleaved / 单 thinking / 非 thinking 块不动）、**保留全部 thinking**（insert_text 与 move_blocks 均不丢；仅 passthrough 不处理）。
- 纯函数（payload-only），接入 [sanitizeAnthropicMessages](../../src/lib/anthropic/sanitize/index.ts#L79)（`processToolBlocks` 之前）——**一处覆盖 driver S3 + web_search 双路径**（评审 A6）。按 `type` 判定覆盖 redacted（评审 A2）。PoC 证交错保留全部 → 200（`[T,text,T,tool,T,tool]` 等 = move_blocks；`[T,marker,T,marker,T,…]` = insert_text），部分相邻仍 400（`pb_P1/P2`）。
- **注（跨消息边界）**：本 pass 在**单条消息内**去相邻；GHC 折叠后若某消息末 thinking 与下条消息首 thinking 相邻（罕见，消息间通常有 user/tool_result 隔开）未覆盖 → 由 L2/L3 兜底。impl 期可评估是否需跨消息去相邻。
- config（见 §3.5）+ telemetry（de-stack 消息数 / 重排块数 / 插入合成标记数 / 采用策略）。

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
- 注：L3 主动过滤命中即整体 strip-all（比 L1 de-stack 更宽）；对已知中毒会话不必依赖 L1 精确性。

### 3.5 配置
- `anthropic.thinking_destack_strategy`（enum `passthrough`/`insert_text`/`move_blocks`，默认 `move_blocks`，L1）——见 §3.1 三策略。
- `anthropic.strip_thinking_on_reject`（bool，默认 `true`，L2）
- `anthropic.poisoned_thinking_quarantine`（bool，默认 `true`，L3）+ `anthropic.poisoned_thinking_ttl_hours`（number，默认 `72`）
- schema（`nullableEnum` for L1 策略）+ state + bundled config.yaml + config 应用。

## 4. 数据流
- **相邻 thinking 毒请求**：L1 de-stack 交错分隔 → 200（提前，无 400、无 quarantine、保留全部 thinking）。← 高发路径，最省。
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
- **L1 单元（三策略）**：`move_blocks`：`[T,T,T,text,toolA,toolB]`→`[T,text,T,tool,T,tool]`（保留全部 3 块、无合成）；真实块不足（全 thinking 消息 `[T,T,T]`）→ 补非空合成标记。`insert_text`：`[T,T,T,text,tools]`→`[T,marker,T,marker,T,text,tools]`（真实块原位、插 2 合成标记）。`passthrough`：不动。共性：`[T,tool,T,tool]` 已非相邻不动；单 T 不动；redacted 相邻同样处理；thinking 内容/相对序不变；空/空白合成标记无效（回归钉死）；user 消息不动；**split 不修**（GHC 折回，钉死不采纳）。
- **L2 单元**：matcher 正/负样本（`thinking.type.enabled` 负命中）；strip-all 移除 thinking+redacted 保留其余。
- **L3 存储**：createDatabase 独立库（不碰 history 单例）；水合/写穿透/TTL 滑动+purge/never-throw；**临时目录 DI**（Bun `os.homedir()` 忽略 `env.HOME`，记忆 `feedback_tests_never_touch_real_env`）；key 归一（主 agent→'')。
- **集成**：L1 de-stack 请求直接 200（不触发 L2/L3）；非-L1 毒 首轮 400→L2→200→L3 落库、次轮 L3 主动 strip-all+TTL 刷新；无 session_id 降级；三 config 门禁；**接线守卫**——原生 env-strategy onResolved 从 env.ctx 读 (session,agent) 落库（锚 HIGH-1）+ web_search 主动过滤命中（锚 MEDIUM-2）+ v4 直连激活（handler-v4 路径，非 legacy）。
- **实证**：PoC 已证 交错保留全部/strip-all→200、确定性 400、split 不修、空分隔符无效；impl 期 :4141 复跑守 matcher + de-stack 规则。

## 7. 暂缓（记 docs/todo）
- 非 CC 客户端 durable key（无 `x-claude-code-session-id`→每轮 L2 一次 400+重试；内容寻址 fallback key 暂缓，评审 MEDIUM-3；若做：store key 泛化 `header-key|content-hash-key`）。
- 跨进程即时缓存失效（当前重启/L2 最终一致）。
- 上游根因反馈（CC 产生连续 thinking 的行为治本在 CC 侧，非本项目）。

## 8. 与现有机制关系
- 与 `thinkingBlockSanitizeCheck`/`thinking_block_message_policy`/`thinking-signature-compat` 正交。
- 与 `thinking-protection.ts`（防误改 thinking）不冲突：L1 de-stack **不删除 thinking**（保留全部，仅交错重排+可能插合成分隔），故不触碰 protection「thinking 须原样保留」的红线（保序、不改内容、不丢块）；impl 需核对 de-stack 的重排在 protection 语义下被允许（相邻布局非「必须保留」的属性，thinking 内容/相对序均不变）。
- PoC 证根因上游 intrinsic（非我方 sanitize），故不替代任何「别碰 latest-assistant」保护。

## 9. 路线图定位：L3 是「会话级连续请求处理」的基础能力（重要未来分支）

L3 的 `(session_id, agent_id)` 持久层**不是本 feature 的一次性补丁，而是未来「基于会话的连续请求处理」方向的第一块基石**（用户明确定为重要未来分支）。设计约束（`against-yagni` 对真实迭代路线 + `richest-data-flow`）：
- **key 作为可复用 primitive**：`(session_id, agent_id)` 归一/查询/落库封装成独立模块（`thinking-quarantine/store.ts` 内的 session-key helper 或抽到 `session-state/`），供未来会话级特性复用，而非内联进 quarantine 逻辑。
- **store 不过度窄化**：sidecar 表虽当前只承载 `poisoned_conversations`，但连接/迁移/热缓存/TTL 骨架应可容纳未来 per-conversation state（例如会话级偏好、累积上下文指纹、连续请求去重/幂等标记）——即「会话级 KV/状态」形态，而非写死单表单用途。impl 期用现有 sidecar init 骨架时保留这一扩展余地（不预建未用表，但不设计成无法扩展）。
- **未来分支候选**（记 docs/todo，不在本 spec 实现）：会话级连续请求的幂等/去重、跨轮上下文累积与压缩决策、会话级路由/模型粘滞、会话级遥测聚合。这些都以 `(session_id, agent_id)` 为共享 key。
- **暂不过度设计**：本 spec 只落地 L3 的 quarantine 用途；但**不把 store/key 设计成只能干这一件事**。具体未来特性到来时各自 spec。


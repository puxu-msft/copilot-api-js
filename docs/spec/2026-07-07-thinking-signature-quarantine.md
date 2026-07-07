# Spec: 中毒会话的 thinking 隔离（session-level thinking quarantine）

- 状态：draft v2（**已按 PoC + 两份对抗评审重写**，方向由 signature-级改为会话-级 strip-all + TTL）。待 subagent 复审 → 用户 review → 实施计划。
- 日期：2026-07-07
- 前身：v1「基于 signature + 索引/二分」已废（索引法被 PoC 实证判死、二分成本高且好块空明文低伤害）。评审存证：[#01 架构](2026-07-07-thinking-signature-quarantine-review-2026-07-07-01.md) / [#02 红队](2026-07-07-thinking-signature-quarantine-review-2026-07-07-02.md)；PoC：[exp/thinking-signature-quarantine/README.md](../../exp/thinking-signature-quarantine/README.md)。
- 相关 skill：`ghc-anthropic-upstream`、`empirical-verification`、`persistence-async-invariants`、`history-sqlite-schema`、`test-isolation`。

## 1. 问题（What & Why）

GHC 上游对某些 thinking 块返回确定性 400：

```
messages.N.content.M: `thinking` or `redacted_thinking` blocks in the latest
assistant message cannot be modified. These blocks must remain as they were in
the original response.
```

某个 thinking 块的 signature 被上游判为「已修改/无法验证」，**烘焙在客户端某条会话历史里**，该会话之后每一轮都随历史重发、每轮都撞同一 400，整条会话卡死。现状兜底是 Claude Code 客户端自行把整轮**全部** thinking 剥掉重发（盲目、且只有 CC 客户端会做）。

## 2. PoC 实证结论（决定设计形状，详见 exp/ README）

- **确定性**：原样重发 ×3 全 400、同一 `content.34`。非间歇。
- **根因 = 上游 intrinsic 毒，非我方 sanitize**：inbound vs outbound 全量结构逐条相同、thinking 逐字节相同 → 我方 sanitize 是 no-op。（红队 H2 证伪。）
- **strip-all thinking → 确定性 200**。
- **索引/signature 定位不可行**：`content.M` 是 GHC 折叠后坐标、指向「第一个越界块」、剥它后索引移位仍 400、无折叠逻辑可参考 → **放弃 signature/索引/二分识别**。
- **好块与坏块都是空明文**（opus-4.8 常态，thinking 文本长度 0）→ 过度剥离只损签名连续性/缓存，**低伤害**，不损可见推理。

**推论**：与其精确定位坏块（贵、脆、收益小），不如**认定「这条会话已中毒」，在一段时间内对它一律 strip-all thinking**——简单、鲁棒、确定性有效、服务端化（任何客户端受益）。

## 3. 设计决策（已与用户敲定）

| 维度 | 决策 |
|---|---|
| 隔离粒度 | **会话级**：key = `(session_id, agent_id)` |
| 命中动作 | **整体 strip-all thinking**（不做 signature 级过滤/二分） |
| 生命周期 | 持久化 sidecar + **3 天滑动 TTL**（每次命中同 key 的新请求刷新 last_seen） |
| 失败轮处理 | 首次撞 400 → strip-all 重试一次解锁本轮（PoC 证 → 200）+ 记录 key |
| 启用方式 | config 开关，默认开；TTL 可配 |

### key 可行性（已核实）
- `session_id` ← header `x-claude-code-session-id`（[sessions.ts:34-43](../../src/lib/history/sessions.ts#L34)）：稳定 per-conversation UUID，会话内每请求复用。
- `agent_id` ← header `x-claude-code-agent-id`（[sessions.ts:60-68](../../src/lib/history/sessions.ts#L60)）：稳定 per-subagent id；主 agent 不发 → `undefined`。
- 两者已在 request context（[context/request.ts](../../src/lib/context/request.ts) `getSessionId`/`getAgentId`）+ history schema（`session_id`/`agent_id`）。`(session,agent)` 稳定唯一标识主/子 agent 的独立会话历史。
- **无 session_id 时**（非 CC 客户端不发该头）：无法 durable 隔离 → 仅每轮 reactive strip-all 解锁，不入库（文档化的降级，不阻塞）。

## 4. 架构（三组件 + 配置）

### 4.1 持久隔离存储 `src/lib/anthropic/thinking-quarantine/store.ts`
- **专用 sidecar SQLite** `~/.local/share/copilot-api/thinking-quarantine.db`，**独立于 `history.enabled`**（history 可关而过滤须常驻）。
- **禁用** `history/sqlite/connection.ts:openDatabase`（模块级单例，会关 history 库，评审 A3/M1）；复用 [sqlite/driver.ts:createDatabase](../../src/lib/history/sqlite/driver.ts#L122)（bun/node 工厂，无单例）+ 自建最小 init（mkdir + WAL/busy_timeout + 建表）。
- 表 `poisoned_conversations(session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', first_seen_at INTEGER, last_seen_at INTEGER, hit_count INTEGER, last_error_sample TEXT, PRIMARY KEY(session_id, agent_id))`。`agent_id` 主 agent 归一为 `''`（NULL 在 SQLite PK 里视作互异，故用哨兵空串）。
- **3 天滑动 TTL**：读时 `now - last_seen_at > TTL` 视为过期（不隔离）；命中有效 key 时 bump `last_seen_at`（滑动续期，评审 H3 的「命中须刷新」以 TTL 形式落地）。周期性 + 惰性 purge 过期行；另设安全 cap（超量按 last_seen 淘汰）防极端。
- 内存热缓存 `Map<"session\0agent", last_seen_at>`，boot 水合，写穿透。**never-throw**：持久化 fire-and-forget 只 warn，过滤只读内存（`persistence-async-invariants`）。

### 4.2 反应式检测 + strip-all 重试策略 `src/lib/request/strategies/poisoned-thinking-retry.ts`
- **接入 v4 活路径** [codec/anthropic/strategies.ts:84](../../src/lib/codec/anthropic/strategies.ts#L84)（经 `adaptLegacyStrategy` 包装，仿 `createServerToolRejectionStrategy` 插入位；评审 A1/H1 —— 直连主流量在此）+ 辅接 legacy `anthropic/pipeline.ts:170`（web_search 双跳也重放中毒历史）。
- **matcher**：守卫式匹配——同时命中 `thinking`/`redacted_thinking` + `cannot be modified`（仿 `legacy-thinking-retry` 双 token，避免误伤 `thinking.type.enabled` 等；评审 M3 要求负样本测试）。per-request 一次性。
- **remediate**：strip-all thinking（含 `redacted_thinking`，strip-all 天然覆盖无 signature 的 redacted，解评审 A2）→ 重试一次（`learning:true`）。PoC 证 → 200。管线「首个 200 即停」与本策略目标一致（我们就要 strip-all 的 200），无控制流张力。
- **落库（onResolved，成功才记）**：读 ctx 的 `(session_id, agent_id)`，写入 store（now、hit_count++、error_sample）。归因混淆在会话级**无害**：即便某次瞬态 400 误记，最坏是该会话 thinking 被剥 ≤3d 滑动窗口（空明文低伤害、自动过期）；无 session_id 则跳过落库。

### 4.3 主动 strip-all 过滤 `src/lib/anthropic/sanitize/poisoned-thinking-filter.ts`
- 请求进入时若 `(session_id, agent_id)` ∈ store 且未过期 → **strip-all thinking**（含 redacted）后再送上游；命中即 bump `last_seen_at`（滑动续期）。
- **接入点**：需在 `(session,agent)` 已知处执行。`session_id`/`agent_id` 由 header 提取进 ctx（早于 sanitize）。方案：把 `(session,agent)` 或「是否已中毒」判定结果传入 sanitize 链（[sanitize/index.ts:79](../../src/lib/anthropic/sanitize/index.ts#L79) 置于 `filterEmptyThinkingBlocks` 之后、`processToolBlocks` 之前，覆盖 driver + web_search 双路径），或在 prepare/handler 侧 ctx 可见处先剥。impl 期择一并写明。
- config 门禁 + telemetry 计数（沿用 `telemetry-dimensions` 的 thinking-sanitize 维度）。

### 4.4 配置
- schema（[config/schema.ts](../../src/lib/config/schema.ts)）：`anthropic.poisoned_thinking_quarantine`（boolean，默认 `true`）+ `anthropic.poisoned_thinking_ttl_hours`（number，默认 `72`=3d）。
- state 字段 + bundled config.yaml 文档 + `config/config.ts` 应用。

## 5. 数据流
- **第 N 轮（首次中毒）**：无 key 记录 → 主动过滤不动 → 发出 → 400 → 反应式 strip-all 重试 → 200 → onResolved 记 `(session,agent)@now`。
- **第 N+1 轮起（同会话，TTL 内）**：主动过滤发出前 strip-all thinking + 刷新 TTL → 零 400。
- **3 天无活动后**：TTL 过期、purge → 该会话恢复正常发 thinking（若毒仍在会重新学一次）。
- **跨重启**：sidecar 水合 → 隔离继续。

## 6. 不变量 / 错误处理
- 持久化 never-throw、fire-and-forget；过滤只读内存缓存。
- 反应式 per-request 一次性；strip-all 重试走 learning 预算（`MAX_LEARNING_RETRIES=32` 充足，只需 1 次）。
- 无 session_id → 反应式仍解锁本轮，但不 durable 隔离（降级，不阻塞）。
- TTL 滑动：命中必 bump last_seen_at（否则活跃中毒会话过期后重撞 400——评审 H3 同理）。
- matcher 窄匹配，不吞其他 400（`never-swallow-errors`）。
- 多进程：WAL + busy_timeout 防损坏；各进程内存缓存经 sidecar 最终一致（进程 A 学到、B 重启前经 reactive 自愈；文档化取舍，评审 M2）。

## 7. 测试（TDD）
- **单元**：matcher 正/负样本（`thinking.type.enabled` 负命中）；strip-all 移除 thinking + redacted_thinking、保留其余块；key 归一（主 agent → `''`）；TTL 过期判定 + 滑动刷新。
- **存储**：createDatabase 独立库（不碰 history 单例）；水合/写穿透/TTL purge/never-throw；**临时目录 DI**（store 构造收 path 参数，Bun `os.homedir()` 忽略 `env.HOME`，记忆 `feedback_tests_never_touch_real_env`）。
- **集成**：首轮 400→strip-all→200→落库；次轮命中→主动 strip-all + TTL 刷新；无 session_id 降级（reactive 解锁、不落库）；config 门禁；onResolved 只成功触发；接入 v4 codec 策略确在直连路径激活（用 handler-v4 路径测，非 legacy）。
- **实证**：PoC 已证 strip-all→200 + 确定性；impl 期用 :4141 复跑守 matcher 措辞。

## 8. 暂缓（记 docs/todo，非本 spec）
- signature 级精确隔离（保留好块）：需二分（贵）+ 好块空明文低伤害，暂不做；若将来 thinking 携带可见推理再评估。
- 跨进程即时缓存失效（当前重启/reactive 最终一致）。
- 非 CC 客户端的 durable 隔离 key（当前无 session_id 降级为每轮 reactive）。

## 9. 与现有机制关系
- 与 `thinkingBlockSanitizeCheck`（空签名启发式）、`thinking_block_message_policy`（无差别剥旧块）正交：本机制是**按会话中毒态**条件性 strip-all。
- 与 `thinking-protection.ts`（防误改 thinking）不冲突：中毒会话的 strip-all 是有意的安全移除（发坏块更糟）。
- PoC 证根因是上游 intrinsic 毒，非我方 sanitize，故**不替代**任何「别碰 latest-assistant」的保护——两者面对不同问题。

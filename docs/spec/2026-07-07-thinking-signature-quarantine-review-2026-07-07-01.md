# Subagent Review 报告 #01：架构可行性（ecc:architect）

- 日期：2026-07-07
- 对象：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md)
- 裁判轴（prompt 指定）：长远正确 + 完整 > 短期将就/成本；亲自核对代码锚点，不轻信 spec。
- 结论：**可行，但照抄接入会在直连主路径失效，核心「保留好块」承诺在真实故障态无法兑现——需先补 4 项再转实施。**

## CRITICAL

**A1. 接入点指向已退役路径**（主会话已亲自复核 confirmed）。spec §3.2 接 `anthropic/pipeline.ts:170`（legacy `executeRequestPipeline`，`DESIGN.md:76` 标 `[bypass]`、仅 web_search 双跳）。直连 `/v1/messages` 活路径是 `codec/anthropic/strategies.ts:84`（v4 driver，`handler-v4.ts:326` 调用，经 `adaptLegacyStrategy` 包装同批 legacy 策略）。照 spec 只接 legacy → 直连流量**完全不激活**，取证请求正是直连重放。修：主接 codec/anthropic/strategies.ts，辅接 legacy（web_search 双跳也重放中毒历史）。

## HIGH

**A2. `redacted_thinking` 无 `signature` 字段**。400 同时点名 `thinking` 和 `redacted_thinking`；redacted 携带 `data` 非 signature（`thinking-protection.ts:4-9`；`content-blocks.ts` 只处理 `type==="thinking"`）。按 signature 隔离无法识别/过滤 redacted 中毒块。修：隔离键用联合键 `{kind, signature|data}`——存储表、内存 Set、过滤谓词、落库全改。

**A3. sidecar 禁用 `connection.ts:openDatabase`（会关 history 库）**。`openDatabase`（`connection.ts:46-51`）是模块级单例，`if (db) closeDatabase()`——用它开另一路径会关掉 history 库。可复用件是 `sqlite/driver.ts:122 createDatabase(path)`（bun/node 工厂，无单例无副作用）。修：sidecar 用 createDatabase + 自建最小 init（mkdir + WAL/busy_timeout + 建表）。

**A4. 索引映射实证不可靠 → 真实故障态退化 strip-all**。grep 全仓无服务端消息折叠近似可参考；报错 `messages.3.content.34` 不映射回我方 payload（msg[3]=4 块 user，无消息 ≥35 块）。索引首选路径大概率猜错 → 每次退化 strip-all → 对本会话等价 CC 基线（spec 想超越的）。**二分定位不是「精化」而是兑现「保留好块」的承重件**。按 against-yagni 裁判轴，压进 backlog 会让 spec 交付不了宣称价值。修：把二分纳入本 spec、索引仅当二分起点提示；或诚实下调成功判据。

## MEDIUM

**A5. onResolved「200 才落库」是相关非因果 + 单槽漏记**。driver `activeStrategy`（`driver.ts:283/329`）单槽被覆盖：只有最后一次改 payload 的策略收 onResolved。故跨策略误记**不会**发生（token-refresh 是最后一次则我方 onResolved 不触发）。但带来两个相反问题：(a) 漏记——我方 strip 后又 token-refresh→200，落到 token-refresh，我方不落库，下轮重学；(b) 因果假阳性——strip→200 只证相关，那个 400 可能瞬态、strip 的其实是好块，误记好 signature（伤害低：空明文只损签名连续性）。修：候选写进 `action.meta`（非暂存策略实例，escalate strip-all 后 meta 自然为空 → onResolved 天然不落库）；文档化 (a)(b) 局限。

## LOW（机械接线，随实施补齐）

- A6. sanitize 接入点正确：`sanitizeAnthropicMessages`(`index.ts:79`) 经 payload-rewrites 进 driver S3 + web_search 直调 → **一处改动覆盖双路径**。建议插在 `filterEmptyThinkingBlocks`(`index.ts:124`) 之后、`processToolBlocks`(`index.ts:131`) 之前。
- A7. learning 预算充足：`MAX_LEARNING_RETRIES=32`（`pipeline.ts:181`），方案 A 两级 escalation 只需 2；`learning:true` 不吃 `maxRetries`。impl 期核 handler-v4 传值 ≥2。escalation 计数靠 per-request 策略工厂闭包（参照 `reactive-rejection.ts:35`）。
- A8. thinking 侧 `signature` 字段存在（`ThinkingBlock` re-export SDK，`content-blocks.ts:41-42` 在用）。
- A9. `PATHS` 加 `THINKING_QUARANTINE_DB`；`APP_DIR` 模块加载时由 `os.homedir()` 定死（Bun 忽略 `env.HOME`，见记忆 `feedback_tests_never_touch_real_env`）→ store 构造须 **DI path 参数**，不内部读 PATHS。
- A10. sidecar 独立于 `history.enabled`（`entries.ts:69-70` 门只挡 insertEntry；独立 createDatabase 绕过）成立。

## 底座真实性核实（全部可用）
单槽 onResolved + learning 预算（legacy/driver 双管道经 adaptLegacyStrategy 语义一致）、sanitize 单点覆盖双路径、runtime-agnostic createDatabase、thinking 侧 signature 字段——四组件机制底座全部真实存在。

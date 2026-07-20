# Token 计数与 Auto-Truncate Calibration

本文记录一个反复调查后**证伪→再定位**的认知：为什么本地 token 估算对 Claude 4.x 系统性低估约 2x，穷举了哪些方案，为什么现有 "o200k + calibration" 架构是正确的本地取舍，以及一个已实测发现的改进方向（从成功请求学习 + history backfill）。

## 结论速览

- **真根因 = tokenizer vocabulary mismatch**（o200k GPT tokenizer ≠ Claude 原生 tokenizer），**不是结构开销**。
- **不存在 Claude 3/4 的本地 tokenizer 库**；**GHC API 没有 count_tokens 端点**；官方 Copilot 客户端也是本地 tiktoken 估算。
- Anthropic `count_tokens` API 是唯一权威源，但自称"估算"、需 anthropic key、限流、每次发完整 payload——不适合截断热路径。
- 现有架构（本地 o200k 估算 + per-model calibration factor + 反应式 per-request ratio）**就是最优本地方案**——calibration factor 是经验自动发现的 tokenizer 比例。
- **已实现（Phase 1，2026-07-11）**：calibration 曾只从 400 错误学习、采样偏向巨型请求；现已改为 **size-aware per-bucket 学习**（也从成功请求学 + history backfill + 出厂 seed），把 count_tokens 误差从 ~50% 高估降到 ~7%。详见末节 + spec/plan `2026-07-11-size-aware-calibration-learning`。

## 现象

auto-truncate 用本地 `countTotalTokens`（`src/lib/anthropic/auto-truncate/token-counting.ts`，o200k gpt-tokenizer 拍平文本）估算请求 token，与上游真实计数比对，factor（真实 / 本地）对 claude-opus-4.8 稳定在 ~2x。

实测基准（history 真实数据，opus-4.8，1274 msgs / 601 tool_use / 601 tool_result / 0 image）：本地估 494139，上游真实 1033154，factor **2.09**。

## 穷举:准确 token 计数的所有途径

| 方案 | 可行性 | 结论 |
|---|---|---|
| **本地 o200k(gpt-tokenizer,现用)** | ✅ 在用 | 结构上无法匹配 Claude tokenizer；靠 calibration 校正 |
| **Anthropic count_tokens API** | ⚠️ 唯一权威源,有代价 | 见下 |
| **本地 Claude tokenizer 库** | ❌ **不存在** | `@anthropic-ai/tokenizer` 只到 Claude 1/2；Claude 3/4 从未发布 |
| **GHC count_tokens 端点** | ❌ **不存在** | 查 microsoft/vscode 最新源码零结果；官方客户端本地 tiktoken 估算 |

### Anthropic 官方文档的决定性证据

来源：`platform.claude.com/docs/en/docs/build-with-claude/token-counting`

> **"Claude Opus 4.7 and later Opus models... use a newer tokenizer. The same input text produces approximately 30% more tokens than on earlier models."**

这直接证实 **opus-4.7+ 换了更密的原生 tokenizer**。叠加 "o200k(GPT) vs Claude tokenizer" 本身的差异，复合成实测的 ~2x。**这不是结构开销，是 tokenizer 本质差异，本地无法弥补。**

官方还确认：
- count_tokens API "应视为**估算**，可能有小幅偏差"——**连官方 API 都不是 100% 准**。
- API 免费但限流（Start 2000 RPM，与 message 限额独立），需 anthropic key（直连 api.anthropic.com），每次要发完整 payload（延迟 + 隐私）。
- 上一轮 assistant 的 thinking 块**不计入** input token；当前轮 thinking **计入**。

### 一段弯路（记录以免重走）

曾一度误判 factor 2x 来自"结构开销"（我们 `contentToText` 把 tool_use/tool_result 拍平丢了结构，而 GHC 官方 tokenizer `refs/vscode-copilot-chat-upstream/.../tokenizer.ts` 有 BaseTokensPerMessage=3、tool_calls×1.5、tools base16+8/tool×1.1、image tiles 等结构常量）。设计过"镜像官方结构算法"的纯本地方案，目标 factor→1.0。

**被 subagent 实测证伪**：即使零结构开销（把所有文本拼起来直接 o200k），factor 仍是 **1.718**（真实 947145 / raw 551246）。忠实移植官方结构算法只把 factor 从 1.71 改善到 ~1.62，**永远到不了 1.0**。残差来自 (a) tokenizer vocabulary mismatch（上述官方 +30% + o200k 差异），(b) 结构化只能补其中一小部分。交叉证据：同算法对 opus-**4.6** factor≈1.02，对 opus-**4.8** factor≈1.6+，唯一变量是模型。**结论：结构化不是银弹，calibration 层是根本必需。**

## 现有架构为何正确

`src/lib/auto-truncate/engine.ts` + `src/lib/request/strategies/auto-truncate.ts`：

1. **本地 o200k 估算**（结构上无法匹配 Claude tokenizer）。
2. **per-model calibration factor**（`ModelLimits.calibrationFactor`，EWMA alpha=0.3，clamp [0.5,3.0]）——
   从上游 400 错误学 `factor = reportedCurrent / gptCount`。这个 factor **就是经验自动发现的 o200k→Claude tokenizer 比例**，无需 API 就自己标定出来。
   持久化在 `~/.local/share/copilot-api/learned-limits.json`。
3. **反应式 per-request ratio**：strategy 每次 400 现算 `ratio = reportedCurrent / gptCount`，把 target 换算到本地口径（`target = limit × target_factor × gptCount / reportedCurrent`）。每请求自适应，不依赖全局 factor。

**没有任何本地方法能超过它**，除非用 count_tokens API（key/延迟/隐私代价使其不适合热路径，仅可做可选 pre-flight 增强）。

## 已实现（Phase 1）:从成功请求学习 + size-aware 因子（实测发现的偏差）

> **状态（2026-07-11）**：本节记录的偏差已由 **size-aware calibration** 特性 Phase 1 落地解决——spec [docs/spec/2026-07-11-size-aware-calibration-learning.md](../spec/2026-07-11-size-aware-calibration-learning.md) + plan [docs/plan/2026-07-11-size-aware-calibration-learning.md](../plan/2026-07-11-size-aware-calibration-learning.md)。落地形态见 [docs/DESIGN.md](../DESIGN.md)「活的架构现状」的 calibration 行（size-aware per-bucket 滑动加权均值 + CalibrationSink 成功腿 + history backfill + 出厂 seed）。下面保留根因分析与实测数据作认知底稿；「实现要点」小节的方案已落地、仅作历史对照。

### 偏差

calibration 曾**只从 400 错误学**（`onTokenLimitExceeded`）。但 400 只发生在**超限巨型请求**上——这是采样偏差。`learned-limits.json` 实测 opus-4.8 **factor 2.202, samples 397**，只覆盖了 factor 谱的最大端。（现已改为也从成功请求学 + size-aware 分桶，见本节顶部状态。）

### 实测:factor 不是常数,随规模上升

40 条随机 opus-4.8 completed 请求（真实 tokens = `input_tokens + cache_read + cache_creation`，本地 = `countTotalTokens(client_request payload)`）：

| 指标 | 值 |
|---|---|
| factor 范围 | **1.236 – 2.174** |
| median / mean | 1.444 / 1.529 |
| stddev | 0.216 |
| 规模依赖 | 小请求(9-46 msgs) ~1.28-1.32；大请求(300-670 msgs) ~1.8-2.2 |

规模驱动（非 tool 百分比——几乎全高 tool 密度，相关系数≈0）：大请求累积大量 code/tool 输出，o200k 对结构化/代码文本比 Claude tokenizer 稀疏得多。reasoning_tokens 全 0，排除不可见 reasoning 干扰。

**后果**：全局 factor 2.2（只从 400 学）系统性**高估典型请求**约 1.6x（真实 ~1.4）。因 pre-check 不在主 `/v1/messages` 路径，不致失败，但不精确，且是"只学失败样本"的采样偏差。

### 收益:用成功请求学习

1. **信号量爆增**：3434 条 opus-4.8 completed vs 屈指可数的 400。
2. **消除采样偏差**：成功请求覆盖全规模段，学习分布从"只有 2.2"变成"1.3-2.2 全谱"。
3. **可立即 backfill**：现有 3434 条历史现成，真实 token 已存在 `entries_v2` 列，冷启动瞬间收敛。

### 诚实的限制

factor 本质**不是单个标量**（随组成在 1.24-2.17 变动）。从成功请求学一个全局标量 → 落在请求混合的加权均值（比"只学 2.2"准得多，但仍有损）。真正 per-request 准确的只有反应式 ratio（仅失败时触发）。理想是 **size/组成感知 factor**（第二步暂缓项）。

### 实现要点（Phase 1 落地形态，原为「供后续会话」）

> 下列要点是设计期给后续会话的提纲，现已由 spec/plan `2026-07-11-size-aware-calibration-learning` 全部落地（部分方案在落地时被 subagent 复审改进——如成功腿走 observability `CalibrationSink` 而非 `onSuccessfulRequest`、factor 由标量升为 per-bucket、EWMA 改 cumulative tok-weighted 滑动窗）。保留作认知对照。

- 成功腿学习：设计提「新增 `onSuccessfulRequest`」，**落地为** observability `CalibrationSink`（订阅 `request.completed`、单一汇聚点、never-throw）。
- **用 wire payload 估算**（`entry_stages` 的 `request_group` / handler 里的 outbound），而非 inbound——与 usage 口径一致更准。**已采纳**（sink 读 `attempts.at(-1).upstreamRequest.body`、backfill 读 `request_group` wire）。
- backfill 用 skill `history-backfill` 模式（可恢复骨架、history_meta version 守卫、keyset 续跑、协作 stop、非阻塞、never-throw）。**已采纳**（`calibration-backfill.ts`，批统计 seed、compound cursor）。
- 成功样本与 400 样本是否共用 factor：**落地为**同一套 per-bucket 累计——size 分桶自动隔离两个 regime（400 落顶桶、成功横跨全桶），张力由分桶结构消解。
- **完整价值需配合主路径 pre-flight**：**Phase 2 pending**（config `auto_truncate.preflight` 默认 OFF）——发送前用 learned factor 判超限、预截断，省掉那次必然失败的 400 往返（几十秒）。

## 参考

- history schema：blob 用 **zstd**（`Bun.zstdDecompressSync`）；真实 token 在 `entries_v2.{input_tokens,cache_read,cache_creation}` 列；payload 在 `entry_stages`（`client_request` inbound / `request_group` wire / `upstream_response` usage）。详见 skill `history-sqlite-schema`。
- calibration 持久化改动纪律：skill `persistence-async-invariants`。
- 官方 tokenizer 算法参考：`refs/vscode-copilot-chat-upstream/extensions/copilot/src/platform/tokenizer/node/tokenizer.ts`。
